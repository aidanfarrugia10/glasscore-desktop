# Code signing policy

Windows Smart App Control and SmartScreen block unsigned programs. GlassCore release binaries
(`glasscore.exe`, the NSIS installer, and `glasscore-broker.exe`) are signed through the
**SignPath Foundation** free code-signing programme for open-source projects.

Free code signing provided by [SignPath.io](https://about.signpath.io/), certificate by
[SignPath Foundation](https://signpath.org/).

## Policy

* Only binaries built by GitHub Actions from this repository's `main` branch or a release tag
  are submitted for signing. Local builds are never signed.
* Every signing request is approved manually by a maintainer.
* Maintainers use multi-factor authentication on GitHub and SignPath.
* Signed binaries contain only code from this repository plus the dependencies listed in
  `Cargo.lock`, `package-lock.json` and the broker's NuGet references.

## Team roles

| Role | Who |
|---|---|
| Committer and reviewer | Repository maintainers |
| Approver | Repository owner |

## Privacy

This program does not transfer any information to other networked systems unless the user
explicitly asks it to (connectivity check to a host the user enters). See [PRIVACY.md](PRIVACY.md).

## Setting it up (maintainers)

1. Apply at <https://signpath.org/apply.html> with this repository.
2. Once accepted, create a SignPath project `glasscore` with an artifact configuration that signs
   `*.exe` inside the uploaded zip, and a signing policy `release-signing`.
3. Add repository secret `SIGNPATH_API_TOKEN` and variable `SIGNPATH_ORGANIZATION_ID`.
4. Push a tag `v*` — the `release` job in `.github/workflows/build.yml` uploads the unsigned
   artifact, waits for approval, and attaches the signed binaries to the GitHub Release.
