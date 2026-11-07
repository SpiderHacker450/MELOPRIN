/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        pv: {
          // Friendship Palette Tokens
          pink: '#F8C8DC',
          softPink: '#FDEFF4',
          berry: '#A85D79',
          coral: '#FF6F61',
          coralLight: '#FF8A80',
          peach: '#FFBE98',
          peachLight: '#FFF2EB',
          sky: '#70B5F9',
          skyLight: '#EBF5FB',
          lavender: '#9C88FF',
          lavenderLight: '#E8E0F8',
          cream: '#FFFDF9',
          scrapbook: '#FAF7F2',
          gold: '#FFD54F',
          choco: '#3D231E',
          cocoa: '#4A3B32',
          purpleDark: '#1A1028',
          purpleSurface: '#2D1B4E',
          text: '#2D232E',
          textLight: '#FBF8FA',
          // Backwards compatibility tokens
          blush: '#FDEFF4',
          rose: '#F8C8DC',
          pearl: '#FFFDF9',
          deepRose: '#A85D79',
          champagne: '#FAF7F2',
          cinema: '#1A1028',
          cinemaSurface: '#2D1B4E',
          warmDark: '#3D231E',
          warmBase: '#4A3B32',
        },
        pinkverse: {
          baby: '#F8C8DC',
          rose: '#FF8A80',
          white: '#FFFFFF',
          ivory: '#FFFDF9',
          deepRose: '#A85D79',
          warmMuted: '#4A3B32',
          gold: '#FFD54F',
          champagne: '#FAF7F2',
          blush: '#FDEFF4',
          cottonCandy: '#E8E0F8',
          lavender: '#9C88FF',
        }
      },
      fontFamily: {
        serif: ['Playfair Display', 'Georgia', 'serif'],
        sans: ['Plus Jakarta Sans', 'Inter', 'system-ui', 'sans-serif'],
        cursive: ['Plus Jakarta Sans', 'system-ui', 'sans-serif'], // Replaced romantic cursive with clean playful bold UI
        editorial: ['Playfair Display', 'Georgia', 'serif'],
        handwriting: ['Plus Jakarta Sans', 'sans-serif'],
      },
      animation: {
        'float-slow': 'float 6s ease-in-out infinite',
        'pulse-glow': 'pulseGlow 3s ease-in-out infinite',
        'shimmer': 'shimmer 2.5s infinite linear',
        'spin-slow': 'spin 14s linear infinite',
      },
      keyframes: {
        float: {
          '0%, 100%': { transform: 'translateY(0px)' },
          '50%': { transform: 'translateY(-8px)' },
        },
        pulseGlow: {
          '0%, 100%': { opacity: '0.6', transform: 'scale(1)' },
          '50%': { opacity: '1', transform: 'scale(1.05)' },
        },
        shimmer: {
          '0%': { backgroundPosition: '-200% 0' },
          '100%': { backgroundPosition: '200% 0' }
        },
      },
    },
  },
  plugins: [],
}
