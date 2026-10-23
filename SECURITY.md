# Security Policy

## Supported versions

Security fixes are provided for the latest published release of `atl-cli` on npm. Older versions are not maintained.

| Version | Supported |
| ------- | --------- |
| latest  | yes       |
| older   | no        |

## Reporting a vulnerability

**Please do not report security vulnerabilities through public GitHub issues, discussions, or pull requests.**

Report privately using GitHub's built-in flow:

**[Report a vulnerability »](https://github.com/clssck/atl-cli/security/advisories/new)**: repository **Security** tab → **Advisories** → **Report a vulnerability**.

Please include:

- affected version(s) and environment (`atl --version`, Bun version, OS)
- a description of the issue and its impact
- steps to reproduce

**Never include live credentials or secrets in a report.** atl stores OAuth tokens in its config directory (`credentials.json`); do not share that file, tokens, or `atl auth status` output containing secrets. Redact site names, ids, and any tenant or personal data before sharing logs or reproductions.

You will receive an acknowledgement of your report, and we will coordinate a fix and a coordinated-disclosure timeline with you. Please give us a reasonable window to release a fix before any public disclosure.
