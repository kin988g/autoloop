import { HubProvider, useHub } from "./context";
import { Layout } from "./components/Layout";
import { AgentsPage } from "./pages/AgentsPage";
import { CardsPage } from "./pages/CardsPage";
import { ChannelsPage } from "./pages/ChannelsPage";
import { MonitorPage } from "./pages/MonitorPage";
import { RulesPage } from "./pages/RulesPage";
import { SecretsPage } from "./pages/SecretsPage";

export default function App() {
  return (
    <HubProvider>
      <Layout>
        <ActivePage />
      </Layout>
    </HubProvider>
  );
}

function ActivePage() {
  const { page } = useHub();
  switch (page) {
    case "monitor":
      return <MonitorPage />;
    case "cards":
      return <CardsPage />;
    case "rules":
      return <RulesPage />;
    case "agents":
      return <AgentsPage />;
    case "channels":
      return <ChannelsPage />;
    case "secrets":
      return <SecretsPage />;
    default:
      return <MonitorPage />;
  }
}
