import { useRouter, type Href } from 'expo-router';
import * as React from 'react';
import { Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';

import { useTheme } from '@/hooks/use-theme';

export interface DemoChoiceCardProps {
  accentColor: string;
  description: string;
  detail: string;
  href: Href;
  status?: string;
  title: string;
}

const HORIZONTAL_PADDING = 16;

export function DemoChoiceCard({
  accentColor,
  description,
  detail,
  href,
  status,
  title,
}: DemoChoiceCardProps): React.JSX.Element {
  const theme = useTheme();
  const router = useRouter();
  const { width } = useWindowDimensions();
  const cardWidth = Math.max(0, width - HORIZONTAL_PADDING * 2);

  return (
    <Pressable
      onPress={() => router.navigate(href)}
      style={({ pressed }) => [pressed && styles.pressed, { width: cardWidth }]}>
      <View style={[styles.card, { backgroundColor: theme.backgroundElement }]}>
        <View style={[styles.accent, { backgroundColor: accentColor }]} />
        <View style={styles.content}>
          <View style={styles.headerRow}>
            <Text style={[styles.title, { color: theme.text }]}>{title}</Text>
            {status ? (
              <View style={[styles.statusPill, { borderColor: accentColor }]}>
                <Text style={[styles.statusText, { color: theme.textSecondary }]}>{status}</Text>
              </View>
            ) : null}
          </View>
          <Text style={[styles.description, { color: theme.text }]}>{description}</Text>
          <Text style={[styles.detail, { color: theme.textSecondary }]}>{detail}</Text>
        </View>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  pressed: {
    opacity: 0.72,
  },
  card: {
    borderRadius: 8,
    flexDirection: 'row',
    minHeight: 136,
    overflow: 'hidden',
  },
  accent: {
    width: 5,
  },
  content: {
    flex: 1,
    gap: 10,
    padding: 16,
  },
  headerRow: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    gap: 10,
    justifyContent: 'space-between',
  },
  title: {
    flex: 1,
    fontSize: 18,
    fontWeight: '700',
  },
  statusPill: {
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: 9,
    paddingVertical: 3,
  },
  statusText: {
    fontFamily: 'Menlo',
    fontSize: 10,
    fontWeight: '700',
    textTransform: 'uppercase',
  },
  description: {
    fontSize: 15,
    lineHeight: 21,
  },
  detail: {
    fontFamily: 'Menlo',
    fontSize: 11,
    lineHeight: 16,
  },
});
