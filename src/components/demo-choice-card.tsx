import { Button, Host, RNHostView } from '@expo/ui/swift-ui';
import { buttonStyle } from '@expo/ui/swift-ui/modifiers';
import { useRouter, type Href } from 'expo-router';
import * as React from 'react';
import { StyleSheet, Text, useWindowDimensions, View } from 'react-native';

import { useTheme } from '@/hooks/use-theme';

export interface DemoChoiceCardProps {
  accentColor: string;
  description: string;
  detail: string;
  href: Href;
  status: string;
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
    <Host matchContents>
      <Button
        modifiers={[buttonStyle('plain')]}
        onPress={() => {
          // @ref LLP 0010#demo-catalog-route — Navigate imperatively so the
          // entire card sits inside a SwiftUI Button label, giving the row a
          // native press animation instead of the JS Pressable's opacity dip.
          // Match Expo Router's default Link semantics: catalog entries are
          // idempotent destinations, while push intentionally creates another
          // stack entry for repeat navigation actions.
          router.navigate(href);
        }}>
        <RNHostView matchContents>
          <View
            style={[
              styles.card,
              { backgroundColor: theme.backgroundElement, width: cardWidth },
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
          </View>
        </RNHostView>
      </Button>
    </Host>
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
