//! Raw TCP to a device along its route: directly, through a SOCKS5 proxy, or
//! through an HTTP proxy's CONNECT tunnel. REST gets this from reqwest; SSH
//! (and later the binary API) need the stream itself, so the two proxy
//! handshakes are done here.

use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

use crate::error::{Error, Result};
use crate::transport::{ProxyConfig, ProxyKind};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);

/// A TCP stream to `host:port`, through `proxy` when given.
pub async fn connect(host: &str, port: u16, proxy: Option<&ProxyConfig>) -> Result<TcpStream> {
    let attempt = async {
        match proxy {
            None => TcpStream::connect((host, port))
                .await
                .map_err(|e| Error::Other(format!("cannot reach {host}:{port}: {e}"))),
            Some(p) => {
                let mut stream = TcpStream::connect((p.host.as_str(), p.port))
                    .await
                    .map_err(|e| Error::Proxy(format!("cannot reach the proxy {}:{}: {e}", p.host, p.port)))?;
                match p.kind {
                    ProxyKind::Http => http_connect(&mut stream, host, port, p).await?,
                    ProxyKind::Socks5 => socks5(&mut stream, host, port, p).await?,
                }
                Ok(stream)
            }
        }
    };
    let stream = tokio::time::timeout(CONNECT_TIMEOUT, attempt)
        .await
        .map_err(|_| Error::Timeout { host: host.to_string(), port })??;
    let _ = stream.set_nodelay(true);
    Ok(stream)
}

/// `CONNECT host:port` on an HTTP proxy; on 200 the stream is the tunnel
async fn http_connect(stream: &mut TcpStream, host: &str, port: u16, p: &ProxyConfig) -> Result<()> {
    let target = if host.contains(':') { format!("[{host}]:{port}") } else { format!("{host}:{port}") };
    let mut req = format!("CONNECT {target} HTTP/1.1\r\nHost: {target}\r\n");
    if let Some(user) = &p.username {
        let creds = base64(format!("{user}:{}", p.password.as_deref().unwrap_or("")).as_bytes());
        req.push_str(&format!("Proxy-Authorization: Basic {creds}\r\n"));
    }
    req.push_str("\r\n");
    stream.write_all(req.as_bytes()).await.map_err(|e| Error::Proxy(e.to_string()))?;

    // read the response head byte by byte, so nothing of the tunnel is consumed
    let mut head = Vec::with_capacity(256);
    let mut byte = [0u8; 1];
    while !head.ends_with(b"\r\n\r\n") {
        if head.len() > 16 * 1024 {
            return Err(Error::Proxy("the proxy's answer is too long".into()));
        }
        let n = stream.read(&mut byte).await.map_err(|e| Error::Proxy(e.to_string()))?;
        if n == 0 {
            return Err(Error::Proxy("the proxy closed the connection".into()));
        }
        head.push(byte[0]);
    }
    let status = String::from_utf8_lossy(&head)
        .lines()
        .next()
        .and_then(|l| l.split_whitespace().nth(1).map(str::to_owned))
        .and_then(|s| s.parse::<u16>().ok())
        .unwrap_or(0);
    match status {
        200..=299 => Ok(()),
        407 => Err(Error::ProxyAuth),
        _ => Err(Error::ProxyRefused { host: host.to_string(), port }),
    }
}

/// SOCKS5 (RFC 1928) with optional username/password (RFC 1929); the proxy
/// resolves the name, like `socks5h`
async fn socks5(stream: &mut TcpStream, host: &str, port: u16, p: &ProxyConfig) -> Result<()> {
    let io = |e: std::io::Error| Error::Proxy(format!("SOCKS5: {e}"));
    let with_auth = p.username.is_some();
    let greeting: &[u8] = if with_auth { &[5, 2, 0, 2] } else { &[5, 1, 0] };
    stream.write_all(greeting).await.map_err(io)?;
    let mut reply = [0u8; 2];
    stream.read_exact(&mut reply).await.map_err(io)?;
    if reply[0] != 5 {
        return Err(Error::Proxy("not a SOCKS5 proxy".into()));
    }
    match reply[1] {
        0 => {}
        2 => {
            let user = p.username.as_deref().unwrap_or("").as_bytes();
            let pass = p.password.as_deref().unwrap_or("").as_bytes();
            if user.len() > 255 || pass.len() > 255 {
                return Err(Error::Proxy("SOCKS5 credentials too long".into()));
            }
            let mut auth = vec![1, user.len() as u8];
            auth.extend_from_slice(user);
            auth.push(pass.len() as u8);
            auth.extend_from_slice(pass);
            stream.write_all(&auth).await.map_err(io)?;
            let mut ok = [0u8; 2];
            stream.read_exact(&mut ok).await.map_err(io)?;
            if ok[1] != 0 {
                return Err(Error::ProxyAuth);
            }
        }
        0xff => return Err(Error::ProxyAuth),
        m => return Err(Error::Proxy(format!("SOCKS5 proxy chose an unsupported method {m}"))),
    }

    let name = host.as_bytes();
    if name.len() > 255 {
        return Err(Error::Proxy("host name too long for SOCKS5".into()));
    }
    let mut req = vec![5, 1, 0, 3, name.len() as u8];
    req.extend_from_slice(name);
    req.extend_from_slice(&port.to_be_bytes());
    stream.write_all(&req).await.map_err(io)?;

    let mut head = [0u8; 4];
    stream.read_exact(&mut head).await.map_err(io)?;
    if head[1] != 0 {
        let why = match head[1] {
            1 => "general failure",
            2 => "not allowed by the proxy's rules",
            3 => "network unreachable",
            4 => "host unreachable",
            5 => "connection refused",
            6 => "TTL expired",
            7 => "command not supported",
            8 => "address type not supported",
            _ => "unknown error",
        };
        return Err(Error::Proxy(format!("the SOCKS5 proxy could not reach {host}:{port}: {why}")));
    }
    // skip the bound address the proxy reports
    let skip = match head[3] {
        1 => 4,
        4 => 16,
        3 => {
            let mut len = [0u8; 1];
            stream.read_exact(&mut len).await.map_err(io)?;
            len[0] as usize
        }
        _ => return Err(Error::Proxy("SOCKS5: bad reply".into())),
    };
    let mut rest = vec![0u8; skip + 2];
    stream.read_exact(&mut rest).await.map_err(io)?;
    Ok(())
}

/// standard base64 (with padding)
pub fn base64(data: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        out.push(T[(n >> 18) as usize & 63] as char);
        out.push(T[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { T[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { T[n as usize & 63] as char } else { '=' });
    }
    out
}

#[cfg(test)]
mod tests {
    #[test]
    fn base64_matches_the_standard() {
        assert_eq!(super::base64(b""), "");
        assert_eq!(super::base64(b"f"), "Zg==");
        assert_eq!(super::base64(b"fo"), "Zm8=");
        assert_eq!(super::base64(b"foo"), "Zm9v");
        assert_eq!(super::base64(b"user:pass"), "dXNlcjpwYXNz");
    }
}
