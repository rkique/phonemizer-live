import { useEffect, useState } from "react";

function MicPermissionModal() {
  const [permissionState, setPermissionState] = useState<PermissionState>("prompt");
  const [dismissed, setDismissed] = useState(false);
  const [requesting, setRequesting] = useState(false);

  useEffect(() => {
    let revoke: (() => void) | undefined;
    navigator.permissions
      ?.query({ name: "microphone" })
      .then((status) => {
        setPermissionState(status.state);
        status.onchange = () => setPermissionState(status.state);
        revoke = () => {
          status.onchange = null;
        };
      })
      .catch(() => {
        // Permissions API doesn't support "microphone" in this browser —
        // fall back to just showing the priming modal.
      });
    return () => revoke?.();
  }, []);

  const requestAccess = async () => {
    setRequesting(true);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((t) => t.stop());
      setPermissionState("granted");
    } catch {
      setPermissionState("denied");
    } finally {
      setRequesting(false);
    }
  };

  if (permissionState === "granted" || dismissed) return null;

  return (
    <div className="mic-modal-backdrop">
      <div className="mic-modal">
        <h2>Microphone access</h2>
        {permissionState === "denied" ? (
          <>
            <p>
              Microphone access is blocked for this site. Enable it in your
              browser's site settings, then reload the page to start
              recording.
            </p>
            <button className="mic-modal-dismiss" onClick={() => setDismissed(true)}>
              Continue anyway
            </button>
          </>
        ) : (
          <>
            <p>
              phonemizer.live needs microphone access to record and
              transcribe your speech. Recordings stay on this machine —
              nothing is uploaded anywhere else.
            </p>
            <button
              className="mic-modal-allow"
              onClick={requestAccess}
              disabled={requesting}
            >
              {requesting ? "Requesting…" : "Allow microphone access"}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

export default MicPermissionModal;
