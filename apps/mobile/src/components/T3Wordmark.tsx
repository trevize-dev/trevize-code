import type { ColorValue } from "react-native";
import Svg, { Path } from "react-native-svg";
import { withUniwind } from "uniwind";

const ThemedPath = withUniwind(Path);

export function T3Wordmark(props: {
  readonly height: number;
  readonly color?: ColorValue;
  readonly colorClassName?: string;
}) {
  const aspectRatio = 500 / 496.5;
  return (
    <Svg
      accessibilityLabel="Trevize"
      height={props.height}
      width={props.height * aspectRatio}
      viewBox="0 0 500 496.5"
    >
      <ThemedPath
        d="M0 190.5V0L168.5 99.5L338 0L500 93L168.5 287.5V496.5H0V381L168.5 287.5L0 190.5Z"
        color={props.color}
        colorClassName={props.colorClassName}
        fill="currentColor"
      />
    </Svg>
  );
}
