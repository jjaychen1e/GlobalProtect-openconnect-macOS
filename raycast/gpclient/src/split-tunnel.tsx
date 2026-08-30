import {
  Action,
  ActionPanel,
  Color,
  Form,
  Icon,
  List,
  showToast,
  Toast,
  useNavigation,
} from "@raycast/api";
import { useState } from "react";
import {
  buildVpnSliceArg,
  emptySplitTunnelConfig,
  reconnect,
  saveSplitTunnelConfig,
  splitTunnelConfig,
  tunnelMode,
  type SplitTunnelConfig,
} from "./gp";

type ListKey = "dnsDomains" | "subnets" | "hosts";

const SECTIONS: {
  key: ListKey;
  title: string;
  hint: string;
  icon: Icon;
  placeholder: string;
}[] = [
  {
    key: "dnsDomains",
    title: "VPN DNS domains",
    hint: "resolved through the VPN DNS at any depth · no route added",
    icon: Icon.Globe,
    placeholder: "example.com",
  },
  {
    key: "subnets",
    title: "Routed subnets",
    hint: "sent through the tunnel",
    icon: Icon.Network,
    placeholder: "10.0.0.0/8",
  },
  {
    key: "hosts",
    title: "Hosts",
    hint: "one route plus an /etc/hosts entry each · needed outside the subnets above",
    icon: Icon.Desktop,
    placeholder: "intranet.example.com",
  },
];

/** Editor for the vpn-slice argument, so the split tunnel is not one long text field. */
export default function Command() {
  const [config, setConfig] = useState<SplitTunnelConfig>(
    () => splitTunnelConfig() ?? emptySplitTunnelConfig(),
  );
  const { push } = useNavigation();

  function persist(next: SplitTunnelConfig) {
    setConfig(next);
    saveSplitTunnelConfig(next);
  }

  function addEntry(key: ListKey, value: string) {
    const trimmed = value.trim();
    if (!trimmed || config[key].includes(trimmed)) {
      return;
    }
    persist({ ...config, [key]: [...config[key], trimmed] });
  }

  function removeEntry(key: ListKey, value: string) {
    persist({ ...config, [key]: config[key].filter((item) => item !== value) });
  }

  const generated = buildVpnSliceArg(config);

  function sharedActions(section?: (typeof SECTIONS)[number]) {
    return (
      <>
        {section ? (
          <Action
            title={`Add to ${section.title}`}
            icon={Icon.Plus}
            shortcut={{ modifiers: ["cmd"], key: "n" }}
            onAction={() =>
              push(
                <EntryForm
                  title={section.title}
                  placeholder={section.placeholder}
                  onSubmit={(value) => addEntry(section.key, value)}
                />,
              )
            }
          />
        ) : null}
        <Action
          title="Set Search Domain"
          icon={Icon.Text}
          onAction={() =>
            push(
              <EntryForm
                title="Search domain"
                placeholder="example.com"
                defaultValue={config.searchDomain}
                onSubmit={(value) =>
                  persist({ ...config, searchDomain: value.trim() })
                }
              />,
            )
          }
        />
        <Action
          title="Reconnect to Apply"
          icon={Icon.Repeat}
          shortcut={{ modifiers: ["cmd"], key: "r" }}
          onAction={async () => {
            try {
              reconnect();
              await showToast({
                style: Toast.Style.Success,
                title: "Reconnecting",
              });
            } catch (error) {
              await showToast({
                style: Toast.Style.Failure,
                title: "Reconnect failed",
                message: error instanceof Error ? error.message : String(error),
              });
            }
          }}
        />
        <Action.CopyToClipboard
          title="Copy Generated Argument"
          content={generated}
          shortcut={{ modifiers: ["cmd", "shift"], key: "c" }}
        />
      </>
    );
  }

  return (
    <List
      navigationTitle="Split Tunnel"
      searchBarPlaceholder={
        tunnelMode() === "full"
          ? "Tunnel Mode is Full — these settings are unused"
          : "Filter entries"
      }
    >
      <List.Section title="Search domain">
        <List.Item
          title={config.searchDomain || "not set"}
          subtitle="-d · lets short names resolve"
          icon={{
            source: Icon.Text,
            tintColor: config.searchDomain ? Color.Green : Color.SecondaryText,
          }}
          actions={<ActionPanel>{sharedActions()}</ActionPanel>}
        />
      </List.Section>
      {SECTIONS.map((section) => (
        <List.Section
          key={section.key}
          title={section.title}
          subtitle={section.hint}
        >
          {config[section.key].map((entry) => (
            <List.Item
              key={entry}
              title={entry}
              icon={section.icon}
              actions={
                <ActionPanel>
                  {sharedActions(section)}
                  <Action
                    title="Remove"
                    icon={Icon.Trash}
                    style={Action.Style.Destructive}
                    shortcut={{ modifiers: ["ctrl"], key: "x" }}
                    onAction={() => removeEntry(section.key, entry)}
                  />
                </ActionPanel>
              }
            />
          ))}
          <List.Item
            title={`Add ${section.title.toLowerCase()}…`}
            icon={Icon.Plus}
            actions={<ActionPanel>{sharedActions(section)}</ActionPanel>}
          />
        </List.Section>
      ))}
    </List>
  );
}

/** One-field form used for every add/edit action. */
function EntryForm({
  title,
  placeholder,
  defaultValue,
  onSubmit,
}: {
  title: string;
  placeholder: string;
  defaultValue?: string;
  onSubmit: (value: string) => void;
}) {
  const { pop } = useNavigation();
  return (
    <Form
      navigationTitle={title}
      actions={
        <ActionPanel>
          <Action.SubmitForm
            title="Save"
            onSubmit={(values: { value: string }) => {
              onSubmit(values.value ?? "");
              pop();
            }}
          />
        </ActionPanel>
      }
    >
      <Form.TextField
        id="value"
        title={title}
        placeholder={placeholder}
        defaultValue={defaultValue}
      />
    </Form>
  );
}
