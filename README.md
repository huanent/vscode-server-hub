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