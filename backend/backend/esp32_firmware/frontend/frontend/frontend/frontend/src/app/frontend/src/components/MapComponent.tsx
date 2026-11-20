"use client";

import dynamic from "next/dynamic";
import { useEffect } from "react";
import type { CircleMarker as LeafletCircleMarker, LeafletMouseEvent } from "leaflet";
import { CircleMarker, MapContainer, Popup, TileLayer, useMap } from "react-leaflet";

export interface IssueRecord {
  id: number;
  category: "pothole" | "stagnant_water" | "illegal_garbage" | string;
  title: string;
  description: string;
  latitude: number;
  longitude: number;
  zone: string;
  confidence: number;
  severity_score: number;
  priority_score: number;
  priority_level: "Critical" | "High" | "Medium" | "Low" | string;
  status: "Open" | "In Progress" | "Resolved" | "Dismissed" | string;
  report_count: number;
  device_id: string;
  image_url: string;
  raw_image_url?: string | null;
  bounding_boxes: Array<{
    category: string;
    confidence: number;
    bbox: number[];
    area_ratio: number;
  }>;
  assigned_crew?: string | null;
  first_reported_at: string;
  last_reported_at: string;
  resolved_at?: string | null;
}

export interface MapComponentProps {
  issues: IssueRecord[];
  selectedIssue: IssueRecord | null;
  onSelectIssue: (issue: IssueRecord) => void;
}

const PIN_STYLE_MAP: Record<string, { stroke: string; fill: string; label: string }> = {
  Resolved: { stroke: "#15803d", fill: "#16a34a", label: "Resolved" },
  Critical: { stroke: "#991b1b", fill: "#dc2626", label: "Critical" },
  High: { stroke: "#b45309", fill: "#d97706", label: "High" },
  Medium: { stroke: "#1d4ed8", fill: "#2563eb", label: "Medium" },
  Low: { stroke: "#475569", fill: "#64748b", label: "Low" },
};

const CATEGORY_TITLES: Record<string, string> = {
  pothole: "Road Pothole",
  stagnant_water: "Stagnant Water",
  illegal_garbage: "Illegal Garbage",
};

function getPinStyle(issue: IssueRecord) {
  if (issue.status === "Resolved") {
    return PIN_STYLE_MAP.Resolved;
  }
  return PIN_STYLE_MAP[issue.priority_level] || PIN_STYLE_MAP.Low;
}

function MapViewportSync({ selectedIssue }: { selectedIssue: IssueRecord | null }) {
  const map = useMap();

  useEffect(() => {
    if (selectedIssue) {
      map.flyTo([selectedIssue.latitude, selectedIssue.longitude], Math.max(map.getZoom(), 14), {
        duration: 0.65,
      });
    }
  }, [selectedIssue, map]);

  return null;
}

function LeafletMapInner({ issues, selectedIssue, onSelectIssue }: MapComponentProps) {
  const defaultCenter: [number, number] = selectedIssue
    ? [selectedIssue.latitude, selectedIssue.longitude]
    : [12.9616, 77.6146];

  return (
    <div className="relative h-full w-full overflow-hidden rounded-lg border border-slate-200 bg-slate-100">
      <MapContainer
        center={defaultCenter}
        zoom={12}
        scrollWheelZoom={true}
        className="h-full w-full"
        style={{ minHeight: "460px" }}
      >
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />

        <MapViewportSync selectedIssue={selectedIssue} />

        {issues.map((issue) => {
          const style = getPinStyle(issue);
          const isSelected = selectedIssue?.id === issue.id;

          return (
            <CircleMarker
              key={issue.id}
              center={[issue.latitude, issue.longitude]}
              radius={isSelected ? 12 : 9}
              pathOptions={{
                color: isSelected ? "#0f172a" : style.stroke,
                weight: isSelected ? 3 : 2,
                fillColor: style.fill,
                fillOpacity: isSelected ? 0.95 : 0.85,
              }}
              eventHandlers={{
                click: (e: LeafletMouseEvent) => {
                  const target = e.target as LeafletCircleMarker;
                  target.openPopup();
                  onSelectIssue(issue);
                },
              }}
            >
              <Popup>
                <div className="space-y-2 text-slate-900">
                  <div className="flex items-center justify-between gap-3 border-b border-slate-100 pb-1.5">
                    <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                      {CATEGORY_TITLES[issue.category] || issue.category}
                    </span>
                    <span
                      className="font-mono text-xs font-semibold tabular-nums"
                      style={{ color: style.fill }}
                    >
                      {issue.status === "Resolved"
                        ? "Resolved"
                        : `${issue.priority_level} · ${issue.priority_score}/100`}
                    </span>
                  </div>

                  <p className="text-sm font-semibold leading-snug text-slate-900">
                    {issue.title}
                  </p>

                  <div className="space-y-0.5 text-xs text-slate-600">
                    <p>
                      Zone: <span className="font-medium text-slate-800">{issue.zone}</span>
                    </p>
                    <p className="font-mono tabular-nums">
                      {issue.latitude.toFixed(5)}, {issue.longitude.toFixed(5)}
                    </p>
                    <p>
                      Reports: <span className="font-mono font-semibold tabular-nums">{issue.report_count}</span>
                      {" · "}
                      Status: <span className="font-medium text-slate-800">{issue.status}</span>
                    </p>
                  </div>

                  <button
                    type="button"
                    onClick={() => onSelectIssue(issue)}
                    className="w-full rounded-md bg-slate-900 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-slate-800 whitespace-nowrap"
                  >
                    Inspect Ticket #{issue.id}
                  </button>
                </div>
              </Popup>
            </CircleMarker>
          );
        })}
      </MapContainer>

      {/* Clean Map Legend */}
      <div className="pointer-events-auto absolute bottom-3 left-3 z-[400] flex flex-wrap items-center gap-x-4 gap-y-1.5 rounded-lg border border-slate-200 bg-white/95 px-3 py-2 text-xs text-slate-700 shadow-sm backdrop-blur-sm">
        {(["Critical", "High", "Medium", "Low", "Resolved"] as const).map((tier) => (
          <span key={tier} className="inline-flex items-center gap-1.5 whitespace-nowrap">
            <span
              className="inline-block h-2.5 w-2.5 rounded-full border"
              style={{
                backgroundColor: PIN_STYLE_MAP[tier].fill,
                borderColor: PIN_STYLE_MAP[tier].stroke,
              }}
              aria-hidden="true"
            />
            <span>{tier}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

const MapComponent = dynamic(() => Promise.resolve(LeafletMapInner), {
  ssr: false,
  loading: () => (
    <div className="flex h-[460px] w-full items-center justify-center rounded-lg border border-slate-200 bg-slate-100 text-sm text-slate-500">
      Loading Bengaluru telemetry map...
    </div>
  ),
});

export default MapComponent;
