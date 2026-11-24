# Security policy

## Reporting a vulnerability

Please report security issues privately through GitHub's
[private vulnerability reporting](../../security/advisories/new) for this repository.
Don't open a public issue for a vulnerability.

Include the GlassCore version, Windows build, and steps to reproduce. You'll get an
acknowledgement within 7 days.

## Scope

Of particular interest:

* Any way for the UI (WebView) or another local process to make the elevated hardware helper do
  something outside its allow-list (see `apps/broker/Program.cs`).
* Fan-control paths that could leave a fan stopped or below its safety floor.
* Data written to disk that the [privacy notes](docs/PRIVACY.md) say isn't stored.

## Release channel

Only binaries attached to GitHub Releases and signed through the SignPath Foundation are
official. Code signing policy: [docs/SIGNING.md](docs/SIGNING.md).
