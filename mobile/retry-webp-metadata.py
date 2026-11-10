from pathlib import Path
import struct,sys
p=Path(sys.argv[1]);b=bytearray(p.read_bytes());assert b[:4]==b'RIFF' and b[8:12]==b'WEBP' and b[12:16]==b'VP8X';b[20]|=4
x=b'<x:xmpmeta xmlns:x="adobe:ns:meta/">PR33577 synthetic evidence attachment retry</x:xmpmeta>'
b+=b'XMP '+struct.pack('<I',len(x))+x+(b'\0' if len(x)%2 else b'');b[4:8]=struct.pack('<I',len(b)-8)
o=p.with_name(p.stem+'-retry.webp');o.write_bytes(b);print(o)
