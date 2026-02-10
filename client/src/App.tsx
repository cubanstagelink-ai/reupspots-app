import { useState, useCallback } from "react";
import { Switch, Route } from "wouter";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "./lib/queryClient";

import { Toaster } from "./components/ui/toaster";
import { TooltipProvider } from "./components/ui/tooltip";
import { Layout } from "./components/Layout";
import { CinematicIntro } from "./components/CinematicIntro";
import { useThemeShift } from "./hooks/use-theme-shift";

import NotFound from "./pages/not-found";

import Feed from "./pages/Feed";
import Profiles from "./pages/Profiles";
import ProfileDetail from "./pages/ProfileDetail";
import MyProfile from "./pages/MyProfile";
import Rules from "./pages/Rules";
import Terms from "./pages/Terms";
import Privacy from "./pages/Privacy";
import Verification from "./pages/Verification";
import Messages from "./pages/Messages";
import BuyCredits from "./pages/BuyCredits";
import ProfessionalVerification from "./pages/ProfessionalVerification";
import Feedback from "./pages/Feedback";
import OpportunityDetail from "./pages/OpportunityDetail";
import PosterProfile from "./pages/PosterProfile";
import Posters from "./pages/Posters";
import AdminDashboard from "./pages/AdminDashboard";

function Router() {
  useThemeShift();

  return (
    <Layout>
      <Switch>
        <Route path="/" component={Feed} />
        <Route path="/profiles" component={Profiles} />
        <Route path="/profiles/:slug" component={ProfileDetail} />
        <Route path="/me" component={MyProfile} />
        <Route path="/rules" component={Rules} />
        <Route path="/terms" component={Terms} />
        <Route path="/privacy" component={Privacy} />
        <Route path="/verification" component={Verification} />
        <Route
          path="/professional-verification"
          component={ProfessionalVerification}
        />
        <Route path="/messages" component={Messages} />
        <Route path="/buy-credits" component={BuyCredits} />
        <Route path="/feedback" component={Feedback} />
        <Route path="/opportunity/:id" component={OpportunityDetail} />
        <Route path="/poster/:userId" component={PosterProfile} />
        <Route path="/posters" component={Posters} />
        <Route path="/admin" component={AdminDashboard} />
        <Route component={NotFound} />
      </Switch>
    </Layout>
  );
}

export default function App() {
  const [introComplete, setIntroComplete] = useState(false);
  const handleIntroDone = useCallback(() => setIntroComplete(true), []);

  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        {!introComplete && <CinematicIntro onComplete={handleIntroDone} />}
        {introComplete && (
          <>
            <Toaster />
            <Router />
          </>
        )}
      </TooltipProvider>
    </QueryClientProvider>
  );
}
