# Agent permissions

In **Antigravity Studio 1.1.0**, click **Ask for approval** below the message box. The popup controls how the selected conversation's agent actions are approved.

| Choice | File changes inside the project | Agent shell commands |
| --- | --- | --- |
| Ask for approval | Ask before applying | Ask before running |
| Approve file edits | Apply automatically | Ask before running |
| Full access | Apply automatically | Run automatically |

The app asks you to confirm before enabling Full access. This selects automatic execution for that conversation. It is not a Windows administrator elevation and does not grant permissions the operating-system user lacks. Shell commands run with that user's permissions and can access files outside the project or use the network. The file tools themselves remain scoped to the selected project. There is no claim of an OS sandbox or an automatic AI safety reviewer.

**Plan** is independent of permissions: it always permits only file inspection and artifact creation. Switch to **Build** to allow the agent to change files or request commands. A connected model must support tool calls for agent actions to run.

Existing conversations without a saved permission mode use Ask for approval. Newly opened blank conversations also start with Ask for approval. Stop an active run before changing its permissions. Selecting one conversation's mode does not change another conversation. The selected mode persists with that conversation.

With Ask for approval, file and command cards in the chat have **Apply change / Run command** and **Reject** buttons. Automatic approvals remain visible as **Approved automatically** with the proposed contents or command. Approval is distinct from success: the following tool result records whether execution completed or failed. File replacements still require a current read, reject stale edits, and save backups.

These choices govern the coding agent's available file-write and command tools. They do not control manual editor saves, commands you type directly into the Terminal panel, or routine requests to your configured model API. They do not add browser automation, general desktop control, or a web-browsing tool. The ChatGPT permission control shown in the reference screenshot belongs to ChatGPT; this app has its own independent controls.
