import { useGT } from "gt-react";
import { CloudIcon } from "lucide-react";

import type { CloudPlacement } from "../trevize/cloudSessions";

/** The "Cloud" choice on one line: where it runs, or that its repository still needs connecting. */
export function CloudItemContent({ placement }: { placement: CloudPlacement }) {
  const gt = useGT();
  const detail =
    placement.status === "not-connected" ? gt("Connect repository") : placement.workspaceName;
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <CloudIcon className="size-3" />
      <span className="min-w-0 truncate">
        {detail ? gt("Cloud · {detail}", { detail }) : gt("Cloud")}
      </span>
    </span>
  );
}

/** The menu value of the "Cloud" choice: picking it connects the repository when it is not. */
export const CONNECT_CLOUD_SELECT_VALUE = "connect-cloud";

export function cloudSelectValue(placement: CloudPlacement): string {
  return placement.status === "not-connected" ? CONNECT_CLOUD_SELECT_VALUE : "cloud";
}
