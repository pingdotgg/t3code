#!/usr/bin/env bash
set -euo pipefail

usage() {
  printf 'Usage: %s ubuntu|fedora [artifact.deb|artifact.rpm]\n' "$0" >&2
  exit 2
}

case "${1:-}" in
  ubuntu)
    guest=ubuntu
    image=ubuntu-24.04-server-cloudimg-amd64.img
    image_url="https://cloud-images.ubuntu.com/releases/noble/release-20261017/$image"
    digest=04e8f2461a16a44e78a370284471f29616cdd9baf1893df25807b71f985b6c94
    extension=deb
    default_port=22401
    ;;
  fedora)
    guest=fedora
    image=Fedora-Cloud-Base-Generic-44-1.7.x86_64.qcow2
    image_url="https://dl.fedoraproject.org/pub/fedora/linux/releases/44/Cloud/x86_64/images/$image"
    digest=28680fe5b371a5a82ebf43a31926e086a168e59949d03969c5093e7071f90b7f
    extension=rpm
    default_port=22402
    ;;
  *) usage ;;
esac
[[ $# -le 2 ]] || usage
artifact="${2:-}"
if [[ -n "$artifact" && ( ! -f "$artifact" || "$artifact" != *."$extension" ) ]]; then
  usage
fi
for tool in qemu-system-x86_64 qemu-img xorriso curl sha256sum ssh ssh-keygen scp; do
  command -v "$tool" >/dev/null || { printf '%s is required.\n' "$tool" >&2; exit 1; }
done
[[ -r /dev/kvm && -w /dev/kvm ]] || { echo "KVM is unavailable." >&2; exit 1; }

cache="${XDG_CACHE_HOME:-$HOME/.cache}/continuum-cloud-smoke"
scratch="$(mktemp -d)"
vm_pid=
cleanup() {
  if [[ -n "$vm_pid" ]]; then
    kill "$vm_pid" 2>/dev/null || true
    wait "$vm_pid" 2>/dev/null || true
  fi
  rm -rf -- "$scratch"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

mkdir -p "$cache"
cache="$(realpath "$cache")"
verify_image() { printf '%s  %s\n' "$digest" "$1" | sha256sum --check --status; }
if ! verify_image "$cache/$image" 2>/dev/null; then
  curl --fail --location --retry 3 --output "$scratch/$image" "$image_url"
  verify_image "$scratch/$image" || { echo "Cloud image checksum mismatch." >&2; exit 1; }
  mv -- "$scratch/$image" "$cache/$image"
fi
qemu-img create -q -f qcow2 -F qcow2 -b "$cache/$image" "$scratch/root.qcow2" 20G
ssh-keygen -q -t ed25519 -N '' -f "$scratch/id"
cat > "$scratch/user-data" <<EOF_CLOUD
#cloud-config
users:
  - name: continuum
    sudo: "ALL=(ALL) NOPASSWD:ALL"
    shell: /bin/bash
    ssh_authorized_keys:
      - $(cat "$scratch/id.pub")
ssh_pwauth: false
EOF_CLOUD
printf 'instance-id: continuum-%s\nlocal-hostname: continuum-%s\n' "$guest" "$guest" > "$scratch/meta-data"
xorriso -as mkisofs -quiet -volid CIDATA -joliet -rock -output "$scratch/seed.iso" "$scratch/user-data" "$scratch/meta-data"

port="${CONTINUUM_VM_SSH_PORT:-$default_port}"
qemu-system-x86_64 \
  -accel kvm -cpu host -m "${CONTINUUM_VM_MEMORY:-4096}" -smp 2 \
  -display none -serial "file:$scratch/serial.log" -monitor none \
  -drive "file=$scratch/root.qcow2,format=qcow2,if=virtio" \
  -drive "file=$scratch/seed.iso,format=raw,media=cdrom,readonly=on" \
  -nic "user,model=virtio-net-pci,hostfwd=tcp:127.0.0.1:$port-:22" &
vm_pid=$!
ssh_options=(-i "$scratch/id" -o BatchMode=yes -o ConnectTimeout=2 -o StrictHostKeyChecking=accept-new -o "UserKnownHostsFile=$scratch/known_hosts")
host=continuum@127.0.0.1
try_until_ssh() {
  for _ in $(seq 1 90); do
    kill -0 "$vm_pid" 2>/dev/null || return 1
    if ssh "${ssh_options[@]}" -p "$port" "$host" true >/dev/null 2>&1; then return 0; fi
    sleep 2
  done
  return 1
}
if ! try_until_ssh; then
  tail -60 "$scratch/serial.log" >&2 || true
  echo "The VM did not accept SSH." >&2
  exit 1
fi
ssh "${ssh_options[@]}" -p "$port" "$host" 'cloud-init status --wait && cat /etc/os-release'
if [[ -n "$artifact" ]]; then
  scp "${ssh_options[@]}" -P "$port" -- "$artifact" "$host:/tmp/continuum.$extension"
  ssh "${ssh_options[@]}" -p "$port" "$host" bash -s -- "$guest" "$extension" <<'EOF_GUEST'
set -euo pipefail
if [[ "$1" == ubuntu ]]; then
  sudo apt-get update -qq
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y /tmp/continuum.deb xvfb xauth curl
else
  sudo dnf install -y /tmp/continuum.rpm xorg-x11-server-Xvfb xorg-x11-xauth
fi
scratch="$(mktemp -d)"
T3CODE_HOME="$scratch" xvfb-run -a continuum-ide --disable-gpu --remote-debugging-port=9224 > "$scratch/continuum.log" 2>&1 &
pid=$!
trap 'kill "$pid" 2>/dev/null || true; wait "$pid" 2>/dev/null || true' EXIT
for _ in $(seq 1 60); do
  if curl -fsS http://127.0.0.1:9224/json/list 2>/dev/null | grep -qi 'Continuum'; then
    echo "Packaged Continuum renderer launched ($2)."
    exit 0
  fi
  kill -0 "$pid" 2>/dev/null || break
  sleep 1
done
tail -100 "$scratch/continuum.log" >&2
exit 1
EOF_GUEST
fi
