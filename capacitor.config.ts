import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.pinkverse.app',
  appName: 'PINKVERSE',
  webDir: 'dist',
  server: {
    androidScheme: 'https',
  },
  android: {
    backgroundColor: '#150D24',
    allowMixedContent: false,
  },
};

export default config;
