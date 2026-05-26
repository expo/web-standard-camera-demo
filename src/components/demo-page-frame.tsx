import * as React from 'react';

export interface DemoPageAction {
  disabled: boolean;
  label: string;
  onPress: () => void;
  running: boolean;
  testID?: string;
}

export interface DemoPageFrameProps {
  action?: 'standard-camera' | DemoPageAction | null;
  controls?: React.ReactNode;
  hud?: React.ReactNode;
  preview: React.ReactNode;
}

export function DemoPageFrame({ controls, hud, preview }: DemoPageFrameProps): React.JSX.Element {
  return (
    <>
      {preview}
      {controls}
      {hud}
    </>
  );
}
