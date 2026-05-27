import * as React from 'react';
import { Pressable, StyleSheet, Text as RNText, View, type StyleProp, type TextStyle, type ViewStyle } from 'react-native';

type SelectionValue = string | number | null;
type TagModifier = { readonly kind: 'tag'; readonly value: SelectionValue };
type PickerStyleModifier = { readonly kind: 'pickerStyle'; readonly value: string };
type DisabledModifier = { readonly kind: 'disabled'; readonly value: boolean };
type ButtonStyleValue = 'automatic' | 'bordered' | 'borderedProminent' | 'borderless' | 'glass' | 'glassProminent' | 'plain';
type ControlSizeValue = 'mini' | 'small' | 'regular' | 'large' | 'extraLarge';
type ButtonStyleModifier = { readonly kind: 'buttonStyle'; readonly value: ButtonStyleValue };
type ControlSizeModifier = { readonly kind: 'controlSize'; readonly value: ControlSizeValue };
type TintModifier = { readonly kind: 'tint'; readonly value: string };
type ForegroundColorModifier = { readonly kind: 'foregroundColor'; readonly value: string };
type FrameModifierValue = {
  readonly height?: number;
  readonly maxHeight?: number;
  readonly maxWidth?: number;
  readonly minHeight?: number;
  readonly minWidth?: number;
  readonly width?: number;
};
type FrameModifier = { readonly kind: 'frame'; readonly value: FrameModifierValue };
type DemoModifier =
  | ButtonStyleModifier
  | ControlSizeModifier
  | DisabledModifier
  | ForegroundColorModifier
  | FrameModifier
  | PickerStyleModifier
  | TagModifier
  | TintModifier;

export function tag(value: SelectionValue): TagModifier {
  return { kind: 'tag', value };
}

export function pickerStyle(value: string): PickerStyleModifier {
  return { kind: 'pickerStyle', value };
}

export function buttonStyle(value: ButtonStyleValue): ButtonStyleModifier {
  return { kind: 'buttonStyle', value };
}

export function controlSize(value: ControlSizeValue): ControlSizeModifier {
  return { kind: 'controlSize', value };
}

export function frame(value: FrameModifierValue): FrameModifier {
  return { kind: 'frame', value };
}

export function foregroundColor(value: string): ForegroundColorModifier {
  return { kind: 'foregroundColor', value };
}

export function tint(value: string): TintModifier {
  return { kind: 'tint', value };
}

export function disabled(value = true): DisabledModifier {
  return { kind: 'disabled', value };
}

export interface HostProps {
  children?: React.ReactNode;
  style?: StyleProp<ViewStyle>;
}

export function Host({ children, style }: HostProps): React.JSX.Element {
  return <View style={style}>{children}</View>;
}

export interface HStackProps {
  alignment?: 'top' | 'center' | 'bottom' | 'firstTextBaseline' | 'lastTextBaseline';
  children?: React.ReactNode;
  modifiers?: readonly DemoModifier[];
  spacing?: number;
  style?: StyleProp<ViewStyle>;
}

export function HStack({ alignment = 'center', children, modifiers = [], spacing = 0, style }: HStackProps): React.JSX.Element {
  const alignItems = alignment === 'top' || alignment === 'firstTextBaseline'
    ? 'flex-start'
    : alignment === 'bottom' || alignment === 'lastTextBaseline'
      ? 'flex-end'
      : 'center';
  const frameStyle = modifiers.find((modifier): modifier is FrameModifier => modifier.kind === 'frame')?.value;
  return (
    <View
      style={[
        {
          alignItems,
          flexDirection: 'row',
          gap: spacing,
          justifyContent: 'center',
        },
        frameStyle ? frameToStyle(frameStyle) : null,
        style,
      ]}>
      {children}
    </View>
  );
}

export interface VStackProps {
  alignment?: 'leading' | 'center' | 'trailing';
  children?: React.ReactNode;
  spacing?: number;
  style?: StyleProp<ViewStyle>;
}

export function VStack({ alignment = 'center', children, spacing = 0, style }: VStackProps): React.JSX.Element {
  const alignItems = alignment === 'leading'
    ? 'flex-start'
    : alignment === 'trailing'
      ? 'flex-end'
      : 'center';
  return <View style={[{ alignItems, gap: spacing }, style]}>{children}</View>;
}

export interface TextProps {
  children?: React.ReactNode;
  modifiers?: readonly DemoModifier[];
  style?: StyleProp<TextStyle>;
}

export function Text({ children, modifiers = [], style }: TextProps): React.JSX.Element {
  const textColor = modifiers.find(
    (modifier): modifier is ForegroundColorModifier => modifier.kind === 'foregroundColor'
  )?.value;
  return <RNText style={[textColor ? { color: textColor } : null, style]}>{children}</RNText>;
}

export interface ButtonProps {
  children?: React.ReactNode;
  label?: string;
  modifiers?: readonly DemoModifier[];
  onPress?: () => void;
  role?: 'cancel' | 'default' | 'destructive';
  systemImage?: string;
}

export function Button({ children, label, modifiers = [], onPress, role = 'default' }: ButtonProps): React.JSX.Element {
  const disabled = modifiers.some((modifier): modifier is DisabledModifier => modifier.kind === 'disabled' && modifier.value);
  const style = modifiers.find((modifier): modifier is ButtonStyleModifier => modifier.kind === 'buttonStyle')?.value;
  const size = modifiers.find((modifier): modifier is ControlSizeModifier => modifier.kind === 'controlSize')?.value;
  const frameStyle = modifiers.find((modifier): modifier is FrameModifier => modifier.kind === 'frame')?.value;
  const tintColor =
    modifiers.find((modifier): modifier is TintModifier => modifier.kind === 'tint')?.value ??
    (role === 'destructive' ? '#ef4444' : '#38bdf8');
  const prominent = style === 'borderedProminent' || style === 'glassProminent';

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        frameStyle ? frameToStyle(frameStyle) : null,
        size === 'large' || size === 'extraLarge' ? styles.buttonLarge : null,
        prominent
          ? { backgroundColor: tintColor, borderColor: tintColor }
          : { borderColor: tintColor, backgroundColor: 'rgba(15, 23, 42, 0.72)' },
        disabled ? styles.buttonDisabled : null,
        pressed && !disabled ? styles.buttonPressed : null,
      ]}>
      {children ?? (
        <RNText style={[styles.buttonText, prominent ? styles.buttonTextProminent : { color: tintColor }]}>
          {label}
        </RNText>
      )}
    </Pressable>
  );
}

export interface ImageProps {
  color?: string;
  size?: number;
  systemName?: string;
}

export function Image({ color = '#94a3b8', size = 16 }: ImageProps): React.JSX.Element {
  return <SymbolView size={size} tintColor={color} />;
}

function frameToStyle(value: FrameModifierValue): ViewStyle {
  return {
    height: value.height,
    maxHeight: value.maxHeight,
    maxWidth: value.maxWidth,
    minHeight: value.minHeight,
    minWidth: value.minWidth,
    width: value.width,
  };
}

export interface PickerProps<T extends SelectionValue = SelectionValue> {
  children?: React.ReactNode;
  label?: string | React.ReactNode;
  modifiers?: readonly DemoModifier[];
  onSelectionChange?: (selection: T) => void;
  selection?: T;
}

export function Picker<T extends SelectionValue = SelectionValue>({
  children,
  onSelectionChange,
  selection,
}: PickerProps<T>): React.JSX.Element {
  const options = React.Children.toArray(children)
    .filter(React.isValidElement<TextProps>)
    .map((child) => {
      const value = child.props.modifiers?.find((modifier): modifier is TagModifier => modifier.kind === 'tag')?.value;
      const disabled = child.props.modifiers?.some(
        (modifier): modifier is DisabledModifier => modifier.kind === 'disabled' && modifier.value
      ) ?? false;
      return {
        disabled,
        label: React.Children.toArray(child.props.children).join(''),
        value,
      };
    })
    .filter((option): option is { disabled: boolean; label: string; value: SelectionValue } => option.value !== undefined);

  return (
    <View style={styles.segmentedControl}>
      {options.map((option) => {
        const selected = option.value === selection;
        return (
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ disabled: option.disabled, selected }}
            disabled={option.disabled}
            key={String(option.value)}
            onPress={() => onSelectionChange?.(option.value as T)}
            style={({ pressed }) => [
              styles.segment,
              selected ? styles.segmentSelected : null,
              option.disabled ? styles.segmentDisabled : null,
              pressed && !option.disabled ? styles.segmentPressed : null,
            ]}>
            <RNText
              style={[
                styles.segmentText,
                selected ? styles.segmentTextSelected : null,
                option.disabled ? styles.segmentTextDisabled : null,
              ]}>
              {option.label}
            </RNText>
          </Pressable>
        );
      })}
    </View>
  );
}

export interface SliderProps {
  max?: number;
  min?: number;
  onValueChange?: (value: number) => void;
  step?: number;
  style?: StyleProp<ViewStyle>;
  value?: number;
}

export function Slider({ max = 1, min = 0, onValueChange, step = 0.01, style, value = min }: SliderProps): React.JSX.Element {
  return (
    <View style={[styles.sliderHost, style]}>
      {React.createElement('input', {
        max,
        min,
        onChange: (event: React.ChangeEvent<HTMLInputElement>) => {
          onValueChange?.(Number(event.currentTarget.value));
        },
        step,
        style: DOM_SLIDER_STYLE,
        type: 'range',
        value,
      })}
    </View>
  );
}

export interface SymbolViewProps {
  name?: string;
  size?: number;
  style?: StyleProp<ViewStyle>;
  tintColor?: string;
  weight?: string;
}

export function SymbolView({ size = 24, style, tintColor = '#94a3b8' }: SymbolViewProps): React.JSX.Element {
  return (
    <View
      style={[
        styles.symbolFallback,
        {
          borderColor: tintColor,
          borderRadius: size / 2,
          height: size,
          width: size,
        },
        style,
      ]}>
      <View style={[styles.symbolSlash, { backgroundColor: tintColor }]} />
    </View>
  );
}

const styles = StyleSheet.create({
  button: {
    alignItems: 'center',
    borderRadius: 8,
    borderWidth: 1,
    justifyContent: 'center',
    minHeight: 38,
    paddingHorizontal: 12,
  },
  buttonDisabled: {
    opacity: 0.4,
  },
  buttonLarge: {
    minHeight: 42,
  },
  buttonPressed: {
    opacity: 0.76,
  },
  buttonText: {
    fontSize: 13,
    fontWeight: '800',
  },
  buttonTextProminent: {
    color: '#f8fafc',
  },
  segmentedControl: {
    backgroundColor: '#0f172a',
    borderColor: '#334155',
    borderRadius: 8,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 3,
    padding: 3,
  },
  segment: {
    alignItems: 'center',
    borderRadius: 6,
    flex: 1,
    minHeight: 34,
    justifyContent: 'center',
    paddingHorizontal: 10,
  },
  segmentPressed: {
    opacity: 0.78,
  },
  segmentDisabled: {
    opacity: 0.42,
  },
  segmentSelected: {
    backgroundColor: '#f8fafc',
  },
  segmentText: {
    color: '#cbd5e1',
    fontSize: 12,
    fontWeight: '700',
  },
  segmentTextSelected: {
    color: '#0f172a',
  },
  segmentTextDisabled: {
    color: '#64748b',
  },
  sliderHost: {
    height: 34,
    justifyContent: 'center',
  },
  symbolFallback: {
    alignItems: 'center',
    borderWidth: 2,
    justifyContent: 'center',
    overflow: 'hidden',
  },
  symbolSlash: {
    height: 2,
    transform: [{ rotate: '-45deg' }],
    width: '130%',
  },
});

const DOM_SLIDER_STYLE = {
  accentColor: '#38bdf8',
  width: '100%',
} as React.CSSProperties;
