#!/bin/sh
# A MikroTik RouterOS 7 (CHR) to test Wingox against, reachable from the LAN.
#
#   dev/routeros-lab.sh          (re)create it and enable the REST API
#   dev/routeros-lab.sh rest     only enable the REST API (after a restart)
#
# It runs the visual-tracert vrnetlab image (RouterOS CHR in QEMU/KVM) with its
# management forwarded on every interface of this host:
#   2443 → REST API (HTTPS, cert signed by a lab CA)   2022 → SSH   2728 → binary API
# Login admin / admin. A lab only: never expose it outside a trusted LAN.
# Every start of the container boots RouterOS fresh, so run "rest" after one.
set -eu

IMAGE="${IMAGE:-visual-tracert/vr-routeros:7.23.8}"
NAME="${NAME:-mikrotik}"
PASSWORD="${VR_PASSWORD:-admin}"
# the LAN address clients use; it goes in the HTTPS certificate's SAN
HOST_IP="${HOST_IP:-$(hostname -I | awk '{print $1}')}"
CA_DIR="${CA_DIR:-$(dirname "$0")/lab-ca}"

ros() {
  docker exec "$NAME" sshpass -p "$PASSWORD" ssh -p 2022 -o StrictHostKeyChecking=no \
    -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -o ConnectTimeout=10 "admin+ct@127.0.0.1" "$1"
}

enable_rest() {
  echo "waiting for RouterOS…"
  i=0
  until ros ':put ok' >/dev/null 2>&1; do
    i=$((i + 1)); [ "$i" -gt 90 ] && { echo "RouterOS did not answer" >&2; exit 1; }
    sleep 2
  done
  vrf=$(ros ':put [/ip service get ssh vrf]' | tr -d '\r\n')
  # a lab CA and, signed by it, an HTTPS certificate whose SAN names this host's IP,
  # so a client that trusts the CA can verify the router fully (chain + name)
  ros ':if ([:len [/certificate find name=wingox-lab-ca]] = 0) do={ /certificate add name=wingox-lab-ca common-name=wingox-lab-ca key-size=2048 days-valid=3650 key-usage=key-cert-sign,crl-sign; /certificate sign wingox-lab-ca }' >/dev/null
  sleep 3
  ros ":if ([:len [/certificate find name=wingox-lab-https]] = 0) do={ /certificate add name=wingox-lab-https common-name=$HOST_IP subject-alt-name=IP:$HOST_IP,IP:127.0.0.1,DNS:wingox-lab key-size=2048 days-valid=825 key-usage=digital-signature,key-encipherment,tls-server; /certificate sign wingox-lab-https ca=wingox-lab-ca }" >/dev/null
  sleep 3
  ros "/ip service set www-ssl certificate=wingox-lab-https disabled=no vrf=$vrf"
  # the CA's public certificate (never its key), to trust it in a client
  ros '/certificate export-certificate wingox-lab-ca file-name=wingox-lab-ca type=pem' >/dev/null
  sleep 1
  mkdir -p "$CA_DIR"
  ros ':put [/file get wingox-lab-ca.crt contents]' | tr -d '\r' | sed '/^$/d' > "$CA_DIR/wingox-lab-ca.pem"
  ros "/ip service set api disabled=no vrf=$vrf"
  # slirp hands the guest the client's real source IP (only 127.0.0.1 becomes 10.0.2.2),
  # so the management VRF needs a default route back through slirp to answer LAN clients
  ros ":if ([:len [/ip route find comment=wingox-lab]] = 0) do={ /ip route add dst-address=0.0.0.0/0 gateway=10.0.2.2@$vrf routing-table=$vrf comment=wingox-lab }"
  echo "REST ready: https://$HOST_IP:2443/rest  (admin / $PASSWORD)"
  echo "lab CA: $CA_DIR/wingox-lab-ca.pem — e.g. curl --cacert it, or 'Allow self-signed' in Wingox"
}

if [ "${1:-}" = "rest" ]; then enable_rest; exit 0; fi

docker rm -f "$NAME" >/dev/null 2>&1 || true
# forward REST and the binary API too, on every interface (the image forwards only SSH, on localhost)
docker run -d --name "$NAME" --restart unless-stopped --network host --privileged --device /dev/kvm \
  -e VR_PASSWORD="$PASSWORD" --entrypoint sh "$IMAGE" -c \
  "sed -i 's#hostfwd=tcp:127.0.0.1:2022-10.0.2.15:22#hostfwd=tcp:0.0.0.0:2022-10.0.2.15:22,hostfwd=tcp:0.0.0.0:2443-10.0.2.15:443,hostfwd=tcp:0.0.0.0:2728-10.0.2.15:8728#' /vr/launch.py && exec /vr/launch.py" >/dev/null
enable_rest
