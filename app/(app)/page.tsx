import LandingHeader from "@/components/landing/landing-header";
import HeroSection from "@/components/landing/hero-section";
import IntegrationSection from "@/components/landing/integration-section";
import FeaturesSection from "@/components/landing/features-section";
import HowItWorksSection from "@/components/landing/how-it-works-section";
import CtaSection from "@/components/landing/cta-section";

/**
 * Renders the landing page composed of header, hero, features, how-it-works, integration, and call-to-action sections.
 *
 * @returns The JSX element representing the complete landing page layout
 */
export default function Home() {
  return (
    <div className="min-h-screen bg-white dark:bg-zinc-950">
      <LandingHeader />
      <HeroSection />
      <FeaturesSection />
      <HowItWorksSection />
      <IntegrationSection />
      <CtaSection />
    </div>
  );
}