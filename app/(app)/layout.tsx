import AppHeader from "@/components/app-header";

/**
 * Application layout that renders the header and a flexible main content area.
 *
 * @param children - Content to be rendered inside the layout's main area
 * @returns A React element containing the application header and a main area that renders `children`
 */
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen flex flex-col">
      <AppHeader />
      <main className="flex-1">{children}</main>
    </div>
  );
}