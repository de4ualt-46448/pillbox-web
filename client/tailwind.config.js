/** Tailwind config — palette extracted from the Android Color.kt / Theme.kt. */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        mintBackground: "#A9E5D8",
        softSurface: "#EFF3F1",
        softSurfaceHighlight: "#FFFFFF",
        softShadowDark: "#D1D9D6",
        softShadowLight: "#FFFFFF",
        forestGreen: "#1B7A5C",
        sageGreen: "#5FA793",
        mintGreen: "#3DD9B4",
        tealAccent: "#2FB9C6",
        paleMint: "#B7ECE0",
        textPrimary: "#1E2A28",
        textSecondary: "#7C8B87",
        textOnGradient: "#FFFFFF",
        lowStockRed: "#E5695A",
        warningAmber: "#E8B34C",
      },
      backgroundImage: {
        brandGradient: "linear-gradient(135deg, #2FB9C6 0%, #3DD9B4 100%)",
        progressHealthy: "linear-gradient(135deg, #1B7A5C 0%, #3DD9B4 100%)",
        progressLow: "linear-gradient(135deg, #E8734C 0%, #E5695A 100%)",
      },
      boxShadow: {
        // Neumorphic raised card (light element on a soft surface)
        neumorphic:
          "8px 8px 16px #D1D9D6, -8px -8px 16px #FFFFFF",
        "neumorphic-sm":
          "4px 4px 8px #D1D9D6, -4px -4px 8px #FFFFFF",
        // Neumorphic inset (pressed/embedded element)
        "neumorphic-inset":
          "inset 4px 4px 8px #D1D9D6, inset -4px -4px 8px #FFFFFF",
      },
      borderRadius: {
        card: "18px",
      },
    },
  },
  plugins: [],
};
