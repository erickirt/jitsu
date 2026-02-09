import { StreamConfig } from "../../lib/schema";
import { Disable } from "../Disable/Disable";
import { Select } from "antd";
import { StreamTitle } from "../../pages/[workspaceId]/streams";
import { WLink } from "../Workspace/WLink";
import { FaExternalLinkAlt } from "react-icons/fa";
import React from "react";
import { SelectorProps } from "./DestinationSelector";

export function SourceSelector(props: SelectorProps<StreamConfig>) {
  const items = props.items.map(stream => ({
    value: stream.id,
    label: <StreamTitle stream={stream} size={"small"} />,
    search: stream.name,
  }));
  return (
    <div className="flex items-center justify-between">
      <Disable disabled={!props.enabled} disabledReason={props.disabledReason}>
        <Select
          popupMatchSelectWidth={false}
          className="w-80"
          value={props.selected}
          onSelect={props.onSelect}
          options={items}
          showSearch={{
            autoClearSearchValue: false,
            filterOption: (input, option) => option?.search.toLowerCase().includes(input.toLowerCase()) || false,
          }}
        />
      </Disable>
      {!props.enabled && props.showLink && (
        <div className="text-lg px-6">
          <WLink href={`/streams?id=${props.selected}`}>
            <FaExternalLinkAlt />
          </WLink>
        </div>
      )}
    </div>
  );
}
