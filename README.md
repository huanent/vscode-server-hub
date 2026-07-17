# Server Hub

Server Hub keeps server connections close to your VS Code workspace. The first supported connection type is SSH.

## Features

- Dedicated Server Hub view in the Activity Bar.
- Add SSH servers from a form in the editor area.
- Open interactive SSH sessions from the connect button beside each server.
- Edit or delete saved servers from the tree context menu.
- Import and export server connections as JSON, including passwords.
- Sync server names, hosts, ports, and usernames through VS Code Settings Sync.
- Store passwords in VS Code Secret Storage instead of plain-text extension state.

## Usage

1. Open Server Hub from the Activity Bar.
2. Select **Add SSH Server** from the Servers view title.
3. Enter the connection details and save the server.
4. Select the terminal button beside the server to connect.
5. Right-click a server to edit or delete it.

Use the import and export buttons in the Server List title to move connections between devices. Export files contain passwords in plain text, so keep them secure and delete them when they are no longer needed.

## Synchronization

Connection metadata is stored in extension global state and registered for Settings Sync. Passwords are encrypted with VS Code Secret Storage and remain device-local, so a password must be entered again when the synchronized connection appears on another device.

## Requirements

- A reachable SSH server that accepts password authentication.
- VS Code Settings Sync enabled when cross-device connection metadata synchronization is desired.

## Current Limitations

- SSH password authentication is currently supported. SSH keys and agent forwarding are not yet available.
- Database and VNC connections are planned but not implemented.