import { useEffect, useState } from 'react';
import { useColorScheme as useRNColorScheme } from 'react-native';

/**
 * To support static rendering, this value needs to be re-calculated on the client side for web
 */
export function useColorScheme() {
  const [hasHydrated, setHasHydrated] = useState(false);

  /* eslint-disable react-hooks/set-state-in-effect -- Preserve the existing client hydration flip. */
  useEffect(() => {
    setHasHydrated(true);
  }, []);
  /* eslint-enable react-hooks/set-state-in-effect */

  const colorScheme = useRNColorScheme();

  if (hasHydrated) {
    return colorScheme;
  }

  return 'light';
}
