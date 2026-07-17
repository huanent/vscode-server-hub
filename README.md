# Server Hub

Server Hub keeps server connections close to your VS Code workspace. The first supported connection type is SSH.

## Features

- Dedicated Server Hub view in the Activity Bar.
- Add SSH servers from a form in the editor area.
- Open interactive SSH sessions in an editor terminal by selecting a server.
- Sync server names, hosts, ports, and usernames through VS Code Settings Sync.
- Store passwords in VS Code Secret Storage instead of plain-text extension state.

## Usage

1. Open Server Hub from the Activity Bar.
2. Select **Add SSH Server** from the Servers view title.
3. Enter the connection details and save the server.
4. Select the server in the tree to connect.

## Synchronization

Connection metadata is stored in extension global state and registered for Settings Sync. Passwords are encrypted with VS Code Secret Storage and remain device-local, so a password must be entered again when the synchronized connection appears on another device.

## Requirements

- A reachable SSH server that accepts password authentication.
- VS Code Settings Sync enabled when cross-device connection metadata synchronization is desired.

## Current Limitations

- SSH password authentication is currently supported. SSH keys and agent forwarding are not yet available.
- Saved connections cannot yet be edited or removed from the tree.
- Database and VNC connections are planned but not implemented.