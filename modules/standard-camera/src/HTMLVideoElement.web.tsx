// Web fallback for the native <Video> view. On Expo Web, use the browser's
// real HTMLVideoElement so importing app routes does not require the iOS view.

import * as React from 'react';
import { StyleSheet, type StyleProp, type ViewStyle } from 'react-native';

type Stream = globalThis.MediaStream;

export type HTMLVideoElement = globalThis.HTMLVideoElement;

export interface VideoProps {
  srcObject?: Stream | null;
  style?: StyleProp<ViewStyle>;
  autoplay?: boolean;
}

export const Video = React.forwardRef<HTMLVideoElement, VideoProps>(function Video(
  props,
  ref
) {
  const videoRef = React.useRef<globalThis.HTMLVideoElement>(null);

  React.useImperativeHandle(ref, () => {
    if (!videoRef.current) {
      throw new Error('Video element is not mounted');
    }
    return videoRef.current;
  }, []);

  React.useEffect(() => {
    const video = videoRef.current;
    if (!video || props.srcObject === undefined) return;
    video.srcObject = props.srcObject ?? null;
    if (props.autoplay && props.srcObject) {
      void video.play();
    }
  }, [props.autoplay, props.srcObject]);

  return (
    <video
      ref={videoRef}
      autoPlay={props.autoplay}
      muted
      playsInline
      style={rnStyleToCss(props.style)}
    />
  );
});

// Translate a React Native style (an object, array, or registered id) into the
// CSS properties HTML elements expect. `StyleSheet.flatten` resolves arrays
// and ids but leaves RN-specific shapes like `transform: [{ scaleX: -1 }]`
// alone, so we convert that one ourselves. The standard idiom for flipping a
// <video> preview is `style="transform: scaleX(-1)"`; this surface accepts the
// RN equivalent without callers having to know about the difference.
function rnStyleToCss(style: StyleProp<ViewStyle>): React.CSSProperties | undefined {
  const flat = StyleSheet.flatten(style) as
    | (Record<string, unknown> & { transform?: unknown })
    | undefined;
  if (!flat) return undefined;
  const { transform, ...rest } = flat;
  const css = rest as React.CSSProperties;
  if (Array.isArray(transform)) {
    const serialized = rnTransformArrayToCss(transform as TransformEntry[]);
    if (serialized) css.transform = serialized;
  } else if (typeof transform === 'string') {
    css.transform = transform;
  }
  return css;
}

type TransformEntry =
  | { perspective: number }
  | { rotate: string }
  | { rotateX: string }
  | { rotateY: string }
  | { rotateZ: string }
  | { scale: number }
  | { scaleX: number }
  | { scaleY: number }
  | { translateX: number }
  | { translateY: number }
  | { skewX: string }
  | { skewY: string };

function rnTransformArrayToCss(entries: TransformEntry[]): string {
  const parts: string[] = [];
  for (const entry of entries) {
    const [key, value] = Object.entries(entry)[0] as [string, number | string];
    switch (key) {
      case 'perspective':
        parts.push(`perspective(${value}px)`);
        break;
      case 'rotate':
      case 'rotateX':
      case 'rotateY':
      case 'rotateZ':
      case 'skewX':
      case 'skewY':
        parts.push(`${key}(${value})`);
        break;
      case 'scale':
      case 'scaleX':
      case 'scaleY':
        parts.push(`${key}(${value})`);
        break;
      case 'translateX':
      case 'translateY':
        parts.push(`${key}(${value}px)`);
        break;
    }
  }
  return parts.join(' ');
}
