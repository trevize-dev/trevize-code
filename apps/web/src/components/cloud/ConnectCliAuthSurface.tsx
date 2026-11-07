import { StandalonePage, StandalonePageHeader } from "../ui/standalone-page";

/**
 * Trevize: this page completed Clerk's browser sign-in for `t3 connect`. The CLI
 * now signs in with a Trevize device code shown in the terminal, so an old link
 * only needs to say where to look.
 */
export function ConnectCliAuthorizeSurface() {
  return (
    <StandalonePage>
      <StandalonePageHeader
        context="Browser authorization"
        title="Approve the sign-in from your terminal"
        description="`t3 connect` signs in with your Trevize account. Run it again and open the link it prints to approve the code."
      />
    </StandalonePage>
  );
}
