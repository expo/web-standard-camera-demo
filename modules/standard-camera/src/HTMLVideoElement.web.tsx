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
      style={StyleSheet.flatten(props.style) as React.CSSProperties}
    />
  );
});
