# Mounts a FUSE filesystem (bindfs, like s3fs or tigrisfs over R2) and serves
# a file read through the mount, or the mount error when FUSE is unavailable.
mkdir -p /src /mnt/fuse /www
echo "read through fuse" > /src/hello.txt
if bindfs /src /mnt/fuse 2> /tmp/error; then
  cat /mnt/fuse/hello.txt > /www/index.html
else
  { echo "mount failed:"; cat /tmp/error; } > /www/index.html
fi
exec busybox httpd -f -p 8080 -h /www
