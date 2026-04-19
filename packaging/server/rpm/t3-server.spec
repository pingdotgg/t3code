# RPM spec for the T3 Code server / CLI.
# This file is used by packaging/server/build-rpm.sh — do not invoke rpmbuild directly.
# The build script sets %{_version}, %{_sourcedir}, and %{_rpmdir} via --define flags
# and places the pre-built staging tree at %{_sourcedir}/t3-server-stage/.

Name:           t3-server
Version:        %{_version}
Release:        1%{?dist}
Summary:        T3 Code server and CLI
License:        MIT
URL:            https://t3.chat
BuildArch:      %{_target_cpu}
Requires:       nodejs >= 22

%description
The t3 command-line tool that powers T3 Code — an AI coding assistant.
Includes the HTTP server and CLI front-end. Requires Node.js >= 22.

# We ship pre-built binaries; no compilation happens inside rpmbuild.
%prep
# nothing

%build
# nothing

%install
rm -rf "%{buildroot}"
cp -a "%{_sourcedir}/t3-server-stage/." "%{buildroot}/"

%files
%defattr(-,root,root,-)
/usr/lib/t3-server/
%attr(0755,root,root) /usr/bin/t3

%changelog
* %(date "+%a %b %d %Y") T3 Tools <support@t3.gg> - %{_version}-1
- Automated packaging build
