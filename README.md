# Server Hub

Server Hub keeps SSH and MySQL connections close to your VS Code workspace.

## Features

- Dedicated Server Hub view in the Activity Bar.
- Add SSH or MySQL servers from the view title menu.
- Open interactive SSH sessions from the connect button beside each server.
- Open MySQL connections in an editor, switch databases, and browse table metadata in list or grid view.
- Double-click a MySQL table to preview its first 100 rows in a separate editor.
- Edit or delete saved servers from the tree context menu.
- Import and export server connections as JSON, including passwords.
- Sync server names, hosts, ports, and usernames through VS Code Settings Sync.
- Store passwords in VS Code Secret Storage instead of plain-text extension state.

## Usage

1. Open Server Hub from the Activity Bar.
2. Select the add button in the Server List title and choose **SSH** or **MySQL**.
3. Enter the connection details and save the server.
4. Select the connect button beside the server.
5. For MySQL connections, select a database and choose list or grid view from the action bar.
6. Double-click a table to preview up to 100 rows in a separate editor.
7. Right-click a server to edit or delete it.

Use the import and export buttons in the Server List title to move connections between devices. Export files contain passwords in plain text, so keep them secure and delete them when they are no longer needed.

## Synchronization

Connection metadata is stored in extension global state and registered for Settings Sync. Passwords are encrypted with VS Code Secret Storage and remain device-local, so a password must be entered again when the synchronized connection appears on another device.

## Requirements

- A reachable SSH or MySQL server that accepts password authentication.
- VS Code Settings Sync enabled when cross-device connection metadata synchronization is desired.

## Current Limitations

- SSH password authentication is currently supported. SSH keys and agent forwarding are not yet available.
- MySQL table previews are read-only and limited to 100 rows.
- MySQL table row counts come from server metadata and may be estimates for some storage engines.