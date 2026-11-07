import { useNavigate } from "@tanstack/react-router";

/**
 * Trevize: T3 Connect signs in with the Trevize account, so the prompt opens the
 * Trevize sign-in in Settings → Connections instead of Clerk's sign-in modal.
 */
export function useT3ConnectAuthPrompt() {
  const navigate = useNavigate();
  const openAuthPrompt = () => {
    void navigate({ to: "/settings/connections" });
  };
  return { openAuthPrompt };
}
