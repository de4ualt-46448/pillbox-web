/** Tailwind config — palette extracted from the Android Color.kt / Theme.kt. */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        mintBackground: "var(--color-mint-background)",
        softSurface: "var(--color-soft-surface)",
        softSurfaceHighlight: "var(--color-soft-surface-highlight)",
        softShadowDark: "var(--color-soft-shadow-dark)",
        softShadowLight: "var(--color-soft-shadow-light)",
        forestGreen: "var(--color-forest-green)",
        sageGreen: "var(--color-sage-green)",
        mintGreen: "var(--color-mint-green)",
        tealAccent: "var(--color-teal-accent)",
        paleMint: "var(--color-pale-mint)",
        textPrimary: "var(--color-text-primary)",
        textSecondary: "var(--color-text-secondary)",
        textOnGradient: "var(--color-text-on-gradient)",
        lowStockRed: "var(--color-low-stock-red)",
        warningAmber: "var(--color-warning-amber)",
      },
      backgroundImage: {
        brandGradient: "linear-gradient(135deg, var(--color-teal-accent) 0%, var(--color-mint-green) 100%)",
        progressHealthy: "linear-gradient(135deg, var(--color-forest-green) 0%, var(--color-mint-green) 100%)",
        progressLow: "linear-gradient(135deg, #E8734C 0%, var(--color-low-stock-red) 100%)",
      },
      boxShadow: {
        neumorphic: "var(--shadow-neumorphic)",
        "neumorphic-sm": "var(--shadow-neumorphic-sm)",
        "neumorphic-inset": "var(--shadow-neumorphic-inset)",
      },
      borderRadius: {
        card: "18px",
      },
    },
  },
  plugins: [],
};
