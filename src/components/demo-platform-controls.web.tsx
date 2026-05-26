import * as React from 'react';
import { Pressable, StyleSheet, Text as RNText, View, type StyleProp, type TextStyle, type ViewStyle } from 'react-native';

type SelectionValue = string | number | null;
type TagModifier = { readonly kind: 'tag'; readonly value: SelectionValue };
type PickerStyleModifier = { readonly kind: 'pickerStyle'; readonly value: string };
type DisabledModifier = { readonly kind: 'disabled'; readonly value: boolean };
type DemoModifier = DisabledModifier | TagModifier | PickerStyleModifier;

export function tag(value: SelectionValue): TagModifier {
  return { kind: 'tag', value };
}

export function pickerStyle(value: string): PickerStyleModifier {
  return { kind: 'pickerStyle', value };
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

export interface TextProps {
  children?: React.ReactNode;
  modifiers?: readonly DemoModifier[];
  style?: StyleProp<TextStyle>;
}

export function Text({ children, style }: TextProps): React.JSX.Element {
  return <RNText style={style}>{children}</RNText>;
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
