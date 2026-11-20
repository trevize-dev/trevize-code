import { useGT } from "gt-react";

import { StandalonePage, StandalonePageHeader } from "../ui/standalone-page";

/**
 * Trevize: this page completed Clerk's browser sign-in for `t3 connect`. The CLI
 * now signs in with a Trevize device code shown in the terminal, so an old link
 * only needs to say where to look.
 */
export function ConnectCliAuthorizeSurface() {
  const gt = useGT();
  return (
    <StandalonePage>
      <StandalonePageHeader
        context={gt("Browser authorization")}
        title={gt("Approve the sign-in from your terminal")}
        description={gt(
          "{command} signs in with your Trevize account. Run it again and open the link it prints to approve the code.",
          { command: "`t3 connect`" },
        )}
      />
    </StandalonePage>
  );
}
