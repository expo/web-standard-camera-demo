import { Link, type Href } from 'expo-router';
import * as React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { useTheme } from '@/hooks/use-theme';

export interface DemoChoiceCardProps {
  accentColor: string;
  description: string;
  detail: string;
  href: Href;
  status: string;
  title: string;
}

export function DemoChoiceCard({
  accentColor,
  description,
  detail,
  href,
  status,
  title,
}: DemoChoiceCardProps): React.JSX.Element {
  const theme = useTheme();

  return (
    <Link href={href} asChild>
      <Pressable
        style={({ pressed }) => [
          styles.card,
          {
            backgroundColor: theme.backgroundElement,
            opacity: pressed ? 0.72 : 1,
          },
        ]}>
        <View style={[styles.accent, { backgroundColor: accentColor }]} />
        <View style={styles.content}>
          <View style={styles.headerRow}>
            <Text style={[styles.title, { color: theme.text }]}>{title}</Text>
            <View style={[styles.statusPill, { borderColor: accentColor }]}>
              <Text style={[styles.statusText, { color: theme.textSecondary }]}>{status}</Text>
            </View>
          </View>
          <Text style={[styles.description, { color: theme.text }]}>{description}</Text>
          <Text style={[styles.detail, { color: theme.textSecondary }]}>{detail}</Text>
        </View>
      </Pressable>
    </Link>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: 8,
    borderCurve: 'continuous',
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
