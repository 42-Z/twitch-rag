/**
 * Каркас панели владельца: боковое меню и разделы со своими адресами.
 *
 * Меню закрыто по умолчанию и открывается кнопкой с тремя полосками; на узком
 * экране оно выезжает шторкой. Состояние сервиса и беды, о которых человеку
 * нужно знать в любом разделе, показываются здесь же — в шапке и над
 * содержимым.
 */

import { useEffect, useState } from "react";
import { Menu } from "lucide-react";
import { Button } from "@/components/ui/button.tsx";
import { Badge } from "@/components/ui/badge.tsx";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert.tsx";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  useSidebar,
} from "@/components/ui/sidebar.tsx";
import { TooltipProvider } from "@/components/ui/tooltip.tsx";
import { Link, usePathname } from "./lib/router.tsx";
import { FOOTER_ROUTES, matchRoute, MENU_ROUTES, type Route, type RouteId } from "./lib/routes.ts";
import { useHealth } from "./lib/owner.ts";
import { getChannel, type ChannelSummary } from "./lib/registry.ts";
import { HomePage } from "./pages/HomePage.tsx";
import { McpPage } from "./pages/McpPage.tsx";
import { ApiPage } from "./pages/ApiPage.tsx";
import { KnowledgePage } from "./pages/KnowledgePage.tsx";
import { ManagePage } from "./pages/ManagePage.tsx";

/**
 * Кнопка меню. `SidebarTrigger` рисует собственную иконку панели, а нужен
 * привычный значок из трёх полосок, поэтому переключатель берётся из
 * состояния панели, а кнопка остаётся штатной.
 */
function MenuButton(): React.JSX.Element {
  const { toggleSidebar } = useSidebar();

  return (
    <Button variant="ghost" size="icon" aria-label="Открыть меню" onClick={toggleSidebar}>
      <Menu className="size-5" />
    </Button>
  );
}

function MenuItems({ routes, current }: { routes: readonly Route[]; current: Route }): React.JSX.Element {
  return (
    <SidebarMenu>
      {routes.map((route) => {
        const Icon = route.icon;
        return (
          <SidebarMenuItem key={route.path}>
            <SidebarMenuButton asChild isActive={route.path === current.path} tooltip={route.title}>
              <Link to={route.path}>
                <Icon />
                <span>{route.title}</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        );
      })}
    </SidebarMenu>
  );
}

export function App(): React.JSX.Element {
  const pathname = usePathname();
  const { route, vodId } = matchRoute(pathname);

  const [adminToken, setAdminToken] = useState("");
  const { health, tokenState } = useHealth(adminToken);
  const [channel, setChannel] = useState<ChannelSummary | undefined>(undefined);
  const [refreshToken, setRefreshToken] = useState(0);

  useEffect(() => {
    getChannel()
      .then(setChannel)
      .catch(() => setChannel(undefined));
  }, [refreshToken]);

  const canManage = tokenState === "valid";
  const onChanged = (): void => setRefreshToken((n) => n + 1);

  /**
   * Страница каждого раздела. Набор объявлен как `Record<RouteId, …>`: пропущенный
   * раздел или лишний ключ — ошибка сборки, а не пустая страница в браузере.
   */
  const pages: Record<RouteId, React.ReactNode> = {
    home: <HomePage />,
    mcp: <McpPage />,
    api: <ApiPage />,
    knowledge: (
      <KnowledgePage
        {...(vodId === undefined ? {} : { vodId })}
        adminToken={adminToken}
        canManage={canManage}
        refreshToken={refreshToken}
        onChanged={onChanged}
      />
    ),
    manage: (
      <ManagePage
        adminToken={adminToken}
        onTokenChange={setAdminToken}
        tokenState={tokenState}
        channel={channel}
        onChanged={onChanged}
      />
    ),
  };

  return (
    <TooltipProvider>
      <SidebarProvider defaultOpen={false}>
        <Sidebar collapsible="offcanvas">
          <SidebarHeader>
            <div className="flex flex-col gap-0.5 px-2 py-1.5">
              <span className="text-sm font-semibold">База знаний канала</span>
              <span className="text-xs text-muted-foreground">
                {channel === undefined ? "канал не указан" : channel.displayName}
              </span>
            </div>
          </SidebarHeader>

          <SidebarContent>
            <SidebarGroup>
              <SidebarGroupLabel>Разделы</SidebarGroupLabel>
              <MenuItems routes={MENU_ROUTES} current={route} />
            </SidebarGroup>
          </SidebarContent>

          <SidebarFooter>
            <MenuItems routes={FOOTER_ROUTES} current={route} />
          </SidebarFooter>
        </Sidebar>

        <SidebarInset>
          <header className="sticky top-0 z-10 flex items-center gap-3 border-b bg-background/95 px-4 py-3 backdrop-blur supports-[backdrop-filter]:bg-background/80">
            <MenuButton />
            <h1 className="min-w-0 flex-1 truncate text-lg font-semibold">{route.title}</h1>
            {health !== undefined && (
              <Badge variant={health.status === "ok" ? "secondary" : "destructive"}>
                {health.status === "ok" ? "работает" : "есть проблемы"}
              </Badge>
            )}
          </header>

          <main className="mx-auto w-full max-w-3xl flex-1 space-y-6 px-4 py-6">
            {health !== undefined && health.status !== "ok" && (
              <Alert variant="destructive">
                <AlertTitle>Не всё готово к работе</AlertTitle>
                <AlertDescription>
                  {Object.entries(health.checks)
                    .filter(([, value]) => value !== "ok")
                    .map(([name]) => name)
                    .join(", ") || "подробности — в разделе состояния"}
                </AlertDescription>
              </Alert>
            )}

            {/* Опрос канала мог ни разу не пройти: тогда новые эфиры не
                появляются, а причина видна только здесь. */}
            {health?.lastCheckError != null && (
              <Alert variant="destructive">
                <AlertTitle>Канал не опрашивается</AlertTitle>
                <AlertDescription>{health.lastCheckError}</AlertDescription>
              </Alert>
            )}

            {pages[route.id]}
          </main>
        </SidebarInset>
      </SidebarProvider>
    </TooltipProvider>
  );
}
