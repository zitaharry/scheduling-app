import LandingHeader from "@/components/landing/landing-header";
import HeroSection from "@/components/landing/hero-section";

export default function Home() {
  return (
    <div className="min-h-screen bg-white dark:bg-zinc-950">
      <LandingHeader />
      <HeroSection />
    </div>
  );
}
