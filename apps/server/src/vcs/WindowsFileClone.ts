// Embedded so the bundled server needs only Windows PowerShell, not an installed
// native addon or a loose script beside the executable. Paths arrive as JSON on
// stdin and never become PowerShell source.
export const windowsFileCloneScript = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
try {
  Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;
public static class T3BlockClone {
  [StructLayout(LayoutKind.Sequential)]
  struct Extents {
    public IntPtr Source;
    public long SourceOffset, TargetOffset, Length;
  }
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool DeviceIoControl(SafeFileHandle file, uint code, ref Extents input,
    int inputSize, IntPtr output, int outputSize, out int returned, IntPtr overlapped);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool GetVolumePathName(string path, StringBuilder volume, int length);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool GetVolumeInformation(string root, StringBuilder name, int nameLength,
    out uint serial, out uint maxName, out uint flags, StringBuilder fs, int fsLength);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool GetDiskFreeSpace(string root, out uint sectors, out uint bytes,
    out uint free, out uint total);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  [return: MarshalAs(UnmanagedType.U1)]
  static extern bool CreateSymbolicLink(string path, string target, uint flags);
  public static void Link(string path, string target, bool directory) {
    uint flags = directory ? 1u : 0u;
    // Developer Mode permits unprivileged creation; older Windows versions do
    // not understand that flag, so retry with the traditional privilege check.
    if (!CreateSymbolicLink(path, target, flags | 2u)) {
      if (Marshal.GetLastWin32Error() != 87 || !CreateSymbolicLink(path, target, flags))
        throw new Win32Exception();
    }
  }
  static string Volume(string path) {
    var root = new StringBuilder(32768);
    if (!GetVolumePathName(path, root, root.Capacity)) throw new Win32Exception();
    return root.ToString();
  }
  public static void Copy(string source, string destination) {
    string root = Volume(source);
    if (!String.Equals(root, Volume(Path.GetDirectoryName(destination)), StringComparison.OrdinalIgnoreCase))
      throw new IOException("Block cloning requires the same volume");
    uint serial, maxName, flags, sectors, bytes, free, total;
    var fs = new StringBuilder(32);
    if (!GetVolumeInformation(root, null, 0, out serial, out maxName, out flags, fs, fs.Capacity))
      throw new Win32Exception();
    if (!String.Equals(fs.ToString(), "ReFS", StringComparison.OrdinalIgnoreCase))
      throw new IOException("Block cloning requires ReFS");
    if (!GetDiskFreeSpace(root, out sectors, out bytes, out free, out total))
      throw new Win32Exception();
    long cluster = (long)sectors * bytes;
    // Sparse/integrity-stream files require additional destination configuration.
    // Let the ordinary checkout/install path materialize them instead.
    if ((File.GetAttributes(source) & (FileAttributes.SparseFile | FileAttributes.ReparsePoint | (FileAttributes)32768)) != 0)
      throw new IOException("Unsupported block clone file attributes");
    using (var input = new FileStream(source, FileMode.Open, FileAccess.Read, FileShare.Read))
    using (var output = new FileStream(destination, FileMode.CreateNew, FileAccess.ReadWrite, FileShare.None)) {
      long length = input.Length;
      output.SetLength(length);
      long aligned = length - length % cluster;
      long chunk = (2147483648L / cluster) * cluster;
      for (long offset = 0; offset < aligned;) {
        long count = Math.Min(chunk, aligned - offset);
        var extent = new Extents { Source = input.SafeFileHandle.DangerousGetHandle(),
          SourceOffset = offset, TargetOffset = offset, Length = count };
        int returned;
        if (!DeviceIoControl(output.SafeFileHandle, 0x00098344, ref extent,
            Marshal.SizeOf(typeof(Extents)), IntPtr.Zero, 0, out returned, IntPtr.Zero))
          throw new Win32Exception();
        offset += count;
      }
      // The final partial cluster cannot be cloned without extending the source.
      input.Position = aligned;
      output.Position = aligned;
      input.CopyTo(output);
    }
  }
}
'@
  function Clone-Entry([string] $source, [string] $destination) {
    $entry = Get-Item -LiteralPath $source -Force
    if ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) {
      if ($entry.LinkType -ne 'SymbolicLink') { throw 'Unsupported reparse point' }
      [T3BlockClone]::Link($destination, $entry.Target[0], $entry.PSIsContainer)
      return
    }
    if ($entry.PSIsContainer) {
      New-Item -ItemType Directory -Path $destination -ErrorAction Stop | Out-Null
      foreach ($child in Get-ChildItem -LiteralPath $source -Force) {
        Clone-Entry $child.FullName ([IO.Path]::Combine($destination, $child.Name))
      }
      [IO.Directory]::SetLastWriteTimeUtc($destination, $entry.LastWriteTimeUtc)
    } else {
      [T3BlockClone]::Copy($source, $destination)
      [IO.File]::SetLastWriteTimeUtc($destination, $entry.LastWriteTimeUtc)
    }
    [IO.File]::SetAttributes($destination, $entry.Attributes)
  }
  $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
  foreach ($source in $request.sources) {
    Clone-Entry $source ([IO.Path]::Combine($request.destination, [IO.Path]::GetFileName($source)))
  }
  exit 0
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
`;
