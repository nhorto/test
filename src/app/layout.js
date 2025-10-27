import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL || 'http://localhost:3000'),
  title: {
    default: "Holistic Bravo | Holistic Wellness, Vegetarian Recipes & Mindful Living",
    template: "%s | Holistic Bravo",
  },
  description: "Join Holistic Bravo for holistic wellness tips, plant-based vegetarian and vegan recipes, mindful living practices, and inspiration for a healthier, more balanced lifestyle.",
  keywords: ["holistic wellness", "vegetarian recipes", "vegan recipes", "plant-based diet", "mindful living", "healthy lifestyle", "wellness tips", "clean eating", "holistic health"],
  authors: [{ name: "Holistic Bravo" }],
  creator: "Holistic Bravo",
  publisher: "Holistic Bravo",
  openGraph: {
    type: "website",
    locale: "en_US",
    url: "/",
    siteName: "Holistic Bravo",
    title: "Holistic Bravo | Holistic Wellness, Vegetarian Recipes & Mindful Living",
    description: "Join Holistic Bravo for holistic wellness tips, plant-based vegetarian and vegan recipes, mindful living practices, and inspiration for a healthier, more balanced lifestyle.",
  },
  twitter: {
    card: "summary_large_image",
    site: "@holisticbravo",
    creator: "@holisticbravo",
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      'max-video-preview': -1,
      'max-image-preview': 'large',
      'max-snippet': -1,
    },
  },
};

export default function RootLayout({ children }) {
  const organizationSchema = {
    "@context": "https://schema.org",
    "@type": "Organization",
    name: "Holistic Bravo",
    url: process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000",
    logo: `${process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000"}/logo.png`,
    description: "Holistic wellness, plant-based recipes, and mindful living inspiration",
    sameAs: [
      "https://www.instagram.com/holisticbravo",
      "https://www.facebook.com/holisticbravo",
      "https://twitter.com/holisticbravo",
      "https://www.youtube.com/@holisticbravo",
    ],
  };

  const websiteSchema = {
    "@context": "https://schema.org",
    "@type": "WebSite",
    name: "Holistic Bravo",
    url: process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000",
    description: "Holistic wellness tips, vegetarian and vegan recipes, and mindful living practices",
    publisher: {
      "@type": "Organization",
      name: "Holistic Bravo",
    },
  };

  return (
    <html lang="en">
      <head>
        <link
          rel="stylesheet"
          href="https://cdn.lineicons.com/4.0/lineicons.css"
        />
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(organizationSchema) }}
        />
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(websiteSchema) }}
        />
      </head>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
