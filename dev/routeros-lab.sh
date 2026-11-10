#!/bin/sh
# A MikroTik RouterOS 7 (CHR) to test Wingox against, reachable from the LAN.
#
#   dev/routeros-lab.sh          (re)create it and enable the REST API
#   dev/routeros-lab.sh rest     only enable the REST API (after a restart)
#
# It runs the visual-tracert vrnetlab image (RouterOS CHR in QEMU/KVM) with its
# management forwarded on every interface of this host:
#   2443 → REST API (HTTPS, self-signed)   2022 → SSH   2728 → binary API
# Login admin / admin. A lab only: never expose it outside a trusted LAN.
# Every start of the container boots RouterOS fresh, so run "rest" after one.
set -eu

IMAGE="${IMAGE:-visual-tracert/vr-routeros:7.23.8}"
NAME="${NAME:-mikrotik}"
PASSWORD="${VR_PASSWORD:-admin}"

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
  ros ':if ([:len [/certificate find name=rest]] = 0) do={ /certificate add name=rest common-name=wingox-lab key-size=2048 days-valid=3650; /certificate sign rest }' >/dev/null
  sleep 4
  ros "/ip service set www-ssl certificate=rest disabled=no vrf=$vrf"
  ros "/ip service set api disabled=no vrf=$vrf"
  # slirp hands the guest the client's real source IP (only 127.0.0.1 becomes 10.0.2.2),
  # so the management VRF needs a default route back through slirp to answer LAN clients
  ros ":if ([:len [/ip route find comment=wingox-lab]] = 0) do={ /ip route add dst-address=0.0.0.0/0 gateway=10.0.2.2@$vrf routing-table=$vrf comment=wingox-lab }"
  echo "REST ready: https://<this-host>:2443/rest  (admin / $PASSWORD, self-signed)"
}

if [ "${1:-}" = "rest" ]; then enable_rest; exit 0; fi

docker rm -f "$NAME" >/dev/null 2>&1 || true
# forward REST and the binary API too, on every interface (the image forwards only SSH, on localhost)
docker run -d --name "$NAME" --restart unless-stopped --network host --privileged --device /dev/kvm \
  -e VR_PASSWORD="$PASSWORD" --entrypoint sh "$IMAGE" -c \
  "sed -i 's#hostfwd=tcp:127.0.0.1:2022-10.0.2.15:22#hostfwd=tcp:0.0.0.0:2022-10.0.2.15:22,hostfwd=tcp:0.0.0.0:2443-10.0.2.15:443,hostfwd=tcp:0.0.0.0:2728-10.0.2.15:8728#' /vr/launch.py && exec /vr/launch.py" >/dev/null
enable_rest
