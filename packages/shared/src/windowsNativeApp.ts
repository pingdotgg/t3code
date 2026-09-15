// Keep references in the child environment: PowerShell never evaluates app names as code.
const prelude = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$request = $env:T3_NATIVE_APP_INPUT | ConvertFrom-Json
`;

// SnapShots already discovers the executable path through WindowsForeground. Tool
// events instead identify an executable, display name, or packaged app's AUMID.
export const windowsApplicationScript =
  prelude +
  String.raw`
$path = $null
$name = $null
$version = ''
if ($request._tag -eq 'path') {
  $path = $request.path
} else {
  $reference = if ($request._tag -eq 'app-id') { $request.appId } else { $request.displayName }
  $processName = [System.IO.Path]::GetFileNameWithoutExtension($reference)
  # Protected processes refuse module access; skip them instead of aborting the lookup.
  $running = Get-Process -ErrorAction SilentlyContinue | Where-Object {
    $_.ProcessName -eq $processName -or ($request._tag -eq 'display-name' -and $_.Description -eq $reference)
  } | Where-Object { $(try { $_.Path } catch { $null }) } | Select-Object -First 1
  if ($running) { $path = $running.Path }
  if (!$path -and $reference -notmatch '[/\\:]') {
    $command = Get-Command -Name ([System.Management.Automation.WildcardPattern]::Escape($reference)) -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($command) { $path = $command.Path }
  }
  if (!$path) {
    $shell = New-Object -ComObject Shell.Application
    $apps = $shell.Namespace('shell:AppsFolder')
    $installed = $apps.Items() | Where-Object {
      $_.Path -eq $reference -or $_.Name -eq $reference -or $_.ExtendedProperty('System.AppUserModel.ID') -eq $reference
    } | Select-Object -First 1
    if ($installed) {
      $name = $installed.Name
      if ($installed.IsFileSystem) {
        $path = $installed.Path
      } else {
        # A packaged app's AppsFolder path is its stable AUMID, so the icon cache
        # needs the package version to notice updates.
        $path = 'shell:AppsFolder\' + $installed.Path
        $family = ($installed.Path -split '!')[0]
        $package = Get-AppxPackage -Name ($family -replace '_[^_]+$', '') -ErrorAction SilentlyContinue |
          Where-Object { $_.PackageFamilyName -eq $family } | Select-Object -First 1
        if ($package) { $version = $package.Version.ToString() }
      }
    }
  }
}
if (!$path) { 'null'; exit }
if ($path -notlike 'shell:*') {
  $file = Get-Item -LiteralPath $path
  if (!$name) { $name = $file.VersionInfo.FileDescription }
  if (!$name) { $name = $file.BaseName }
  $version = $file.LastWriteTimeUtc.Ticks.ToString()
}
@{ path = $path; displayName = $name; version = $version } | ConvertTo-Json -Compress
`;

// The Windows Shell resolves both executable icons and packaged-app assets.
// WPF's bitmap bridge preserves alpha; the helper owns and releases the HBITMAP.
export const windowsIconScript =
  prelude +
  String.raw`
Add-Type -AssemblyName PresentationCore, WindowsBase, System.Xaml
Add-Type -ReferencedAssemblies PresentationCore, WindowsBase, System.Xaml -TypeDefinition @'
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Media.Imaging;
public static class T3AppIcon {
  [StructLayout(LayoutKind.Sequential)]
  public struct Size { public int Width; public int Height; }
  [ComImport, Guid("bcc18b79-ba16-442f-80c4-8a59c30c463b"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface ImageFactory {
    [PreserveSig] int GetImage(Size size, uint flags, out IntPtr bitmap);
  }
  [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
  static extern void SHCreateItemFromParsingName(string path, IntPtr context, ref Guid iid, [MarshalAs(UnmanagedType.Interface)] out ImageFactory factory);
  [DllImport("gdi32.dll")]
  static extern bool DeleteObject(IntPtr value);
  public static void Save(string path, string output, int size) {
    Guid iid = typeof(ImageFactory).GUID;
    ImageFactory factory;
    SHCreateItemFromParsingName(path, IntPtr.Zero, ref iid, out factory);
    IntPtr bitmap = IntPtr.Zero;
    try {
      Marshal.ThrowExceptionForHR(factory.GetImage(new Size { Width = size, Height = size }, 0x104, out bitmap));
      var image = System.Windows.Interop.Imaging.CreateBitmapSourceFromHBitmap(bitmap, IntPtr.Zero, Int32Rect.Empty, BitmapSizeOptions.FromWidthAndHeight(size, size));
      var encoder = new PngBitmapEncoder();
      encoder.Frames.Add(BitmapFrame.Create(image));
      using (var stream = File.Create(output)) { encoder.Save(stream); }
    } finally {
      if (bitmap != IntPtr.Zero) DeleteObject(bitmap);
      Marshal.ReleaseComObject(factory);
    }
  }
}
'@
[T3AppIcon]::Save($request.path, $request.outputPath, $request.size)
`;
