# File links

File references in web and desktop chat appear as clickable chips. By default, each chip shows the
file name and adds parent folders only when two links would otherwise look the same. Hover a chip to
see its full path. The mobile renderer remains basename-only.

On web or desktop, enable **Settings → General → File chip paths** to show a compact path directly
in each chip. Files safely identified inside the project use `./`. For projects under your home
directory, other home files use `~/`; files outside both keep their absolute path. Authored paths
containing `.` or `..` also stay absolute because resolving them safely requires the owning
filesystem. Line and column numbers stay attached to the path.
