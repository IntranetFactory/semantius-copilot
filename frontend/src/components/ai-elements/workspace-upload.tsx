/**
 * The composer's "+" button: pick a local file, upload it into the session's
 * /workspace (POST /workspace/:sessionId/files), report the FINAL name back —
 * the server renames on collision (`x.pdf` -> `x (1).pdf`), and what the
 * caller inserts into the composer must match what landed on disk.
 *
 * Deliberately NOT the ai-elements attachment stack (PromptInputProvider +
 * PromptInputActionAddAttachments): mounting the provider would silently
 * override AgentChat's controlled textarea value (provider props spread after
 * own props in prompt-input.tsx), and attachments-as-message-parts is not the
 * model here — files go to the workspace, the message just mentions them.
 */
import { PlusIcon } from 'lucide-react';
import { useRef, useState } from 'react';

import { Spinner } from '@/components/ui/spinner';
import { PromptInputButton } from './prompt-input';
import { BACKEND, type ChatAuth, uploadWorkspaceFile } from './session';

export function WorkspaceUploadButton({
  auth,
  sessionId,
  onEnsureSession,
  baseUrl = BACKEND.baseUrl,
  onUploaded,
  onError,
}: {
  /** The user's own credential — same one the chat surface uses. */
  auth: ChatAuth;
  /** The live session's id. Absent = draft mode: the button falls back to
   * onEnsureSession, and is disabled only when that is missing too. */
  sessionId?: string;
  /** Draft-mode fallback: answers a session id, creating the session on first
   * use. A failed create surfaces through onError like any upload failure. */
  onEnsureSession?: () => Promise<string>;
  baseUrl?: string;
  /** Fires with the FINAL (possibly renamed) file name after a successful upload. */
  onUploaded: (name: string) => void;
  /** Fires with a message on failure, and with undefined when a new attempt starts. */
  onError: (message: string | undefined) => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const usable = Boolean(sessionId || onEnsureSession);

  async function handleFile(file: File | undefined) {
    if (!file || !usable || uploading) return;
    setUploading(true);
    onError(undefined);
    try {
      const id = sessionId ?? (await onEnsureSession?.());
      if (!id) throw new Error('no session');
      const { name } = await uploadWorkspaceFile(auth, id, file, baseUrl);
      onUploaded(name);
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setUploading(false);
    }
  }

  return (
    <>
      <input
        ref={fileRef}
        type="file"
        className="hidden"
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          // Reset so picking the same file again re-fires onChange.
          event.currentTarget.value = '';
          void handleFile(file);
        }}
      />
      <PromptInputButton
        tooltip={usable ? 'Upload a file to the workspace' : 'Send a message first to start a session'}
        disabled={!usable || uploading}
        onClick={() => fileRef.current?.click()}
        aria-label="Upload file to workspace"
      >
        {uploading ? <Spinner className="size-4" /> : <PlusIcon className="size-4" />}
      </PromptInputButton>
    </>
  );
}
