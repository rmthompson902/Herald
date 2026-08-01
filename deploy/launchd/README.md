# launchd LaunchAgents

The two per-user LaunchAgent plist templates in this directory (`...node-red.plist.template` and
`...webapp.plist.template`) auto-start the scheduling engine and the FastAPI webapp at login.
`install.sh` renders them for this machine's actual paths (repo location, `node` binary) and loads
them — nothing here is hand-edited or machine-specific.

**Install, verify, restart, uninstall, and the macOS Full Disk Access gotcha are documented in
[../../docs/07-deployment-operations.md](../../docs/07-deployment-operations.md).**
