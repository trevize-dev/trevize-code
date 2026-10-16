import { createFileRoute } from "@tanstack/react-router";

import { SpaceView } from "../trevize/SpaceView";

export interface SpaceSearch {
  /** The open agent's Trevize thread id; absent shows the space chat. */
  readonly tab?: string;
}

export const Route = createFileRoute("/_chat/spaces/$spaceId")({
  validateSearch: (raw: Record<string, unknown>): SpaceSearch =>
    typeof raw.tab === "string" && raw.tab ? { tab: raw.tab } : {},
  component: SpaceRoute,
});

function SpaceRoute() {
  const { spaceId } = Route.useParams();
  const { tab } = Route.useSearch();
  return <SpaceView spaceId={spaceId} {...(tab ? { tab } : {})} />;
}
