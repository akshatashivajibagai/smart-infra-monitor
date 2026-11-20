"use client";

import dynamic from "next/dynamic";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Camera,
  CheckCircle2,
  ExternalLink,
  Filter,
  Loader2,
  MapPin,
  Radio,
  RefreshCw,
  Search,
  Upload,
  Wrench,
  X,
} from "lucide-react";
import type { IssueRecord, MapComponentProps } from "../components/MapComponent";

const MapComponent = dynamic<MapComponentProps>(() => import("../components/MapComponent"), {
  ssr: false,
  loading: () => (
    <div className="flex h-[460px] w-full items-center justify-center rounded-lg border border-slate-200 bg-slate-100 text-sm text-slate-500">
      Initializing geospatial command map...
    </div>
  ),
});

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

interface DeviceRecord {
  id: number;
  device_id: string;
  name: string;
  zone: string;
  status: string;
  last_latitude: number | null;
  last_longitude: number | null;
  last_seen: string;
  total_uploads: number;
  firmware_version: string;
}

interface StatsResponse {
  total_issues: number;
  open_issues: number;
  in_progress_issues: number;
  resolved_issues: number;
  total_reports: number;
  deduplicated_merges: number;
  avg_priority_score: number;
  by_status: Record<string, number>;
  by_priority: Record<string, number>;
  by_category: Record<string, number>;
  devices: {
    total: number;
    online: number;
    offline: number;
  };
}

interface TelemetryIngestResponse {
  status: string;
  deduplicated: boolean;
  distance_meters: number | null;
  issue: IssueRecord;
  detections: Array<{
    category: string;
    confidence: number;
    bbox: number[];
    area_ratio: number;
  }>;
  inference_ms: number;
}

const CATEGORY_LABELS: Record<string, string> = {
  pothole: "Road Pothole",
  stagnant_water: "Stagnant Water",
  illegal_garbage: "Illegal Garbage",
};

const PRIORITY_TEXT_COLOR: Record<string, string> = {
  Critical: "text-red-700",
  High: "text-amber-700",
  Medium: "text-blue-700",
  Low: "text-slate-600",
};

const PRIORITY_BAR_COLOR: Record<string, string> = {
  Critical: "bg-red-600",
  High: "bg-amber-500",
  Medium: "bg-blue-600",
  Low: "bg-slate-500",
};

const STATUS_TEXT_COLOR: Record<string, string> = {
  Open: "text-red-700",
  "In Progress": "text-amber-700",
  Resolved: "text-emerald-700",
  Dismissed: "text-slate-500",
};

const BENGALURU_PRESETS = [
  { label: "Silk Board", lat: "12.9177", lon: "77.6238" },
  { label: "Indiranagar", lat: "12.9784", lon: "77.6408" },
  { label: "MG Road", lat: "12.9756", lon: "77.6066" },
  { label: "Whitefield", lat: "12.9850", lon: "77.7366" },
];

function formatRelativeTime(isoString: string): string {
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return "Unknown";
  const diffSec = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000));
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  return `${Math.floor(diffHr / 24)}d ago`;
}

function resolveImageUrl(path: string): string {
  if (!path) return "";
  if (path.startsWith("http://") || path.startsWith("https://")) return path;
  return `${API_BASE_URL}${path.startsWith("/") ? path : `/${path}`}`;
}

export default function CivicWatchDashboardPage() {
  const [issues, setIssues] = useState<IssueRecord[]>([]);
  const [devices, setDevices] = useState<DeviceRecord[]>([]);
  const [stats, setStats] = useState<StatsResponse | null>(null);
  const [selectedIssue, setSelectedIssue] = useState<IssueRecord | null>(null);

  const [loading, setLoading] = useState<boolean>(true);
  const [refreshing, setRefreshing] = useState<boolean>(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [imageErrorId, setImageErrorId] = useState<number | null>(null);

  // Ticket Table Filters
  const [statusFilter, setStatusFilter] = useState<string>("All");
  const [categoryFilter, setCategoryFilter] = useState<string>("All");
  const [priorityFilter, setPriorityFilter] = useState<string>("All");
  const [searchQuery, setSearchQuery] = useState<string>("");

  // Detail Drawer Updates
  const [crewInput, setCrewInput] = useState<string>("");
  const [updatingStatus, setUpdatingStatus] = useState<boolean>(false);

  // Simulate ESP32 Upload Modal State
  const [isUploadOpen, setIsUploadOpen] = useState<boolean>(false);
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploadPreviewUrl, setUploadPreviewUrl] = useState<string | null>(null);
  const [uploadDeviceId, setUploadDeviceId] = useState<string>("ESP32-CAM-BLR-01");
  const [uploadLat, setUploadLat] = useState<string>("12.9177");
  const [uploadLon, setUploadLon] = useState<string>("77.6238");
  const [uploading, setUploading] = useState<boolean>(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploadResult, setUploadResult] = useState<TelemetryIngestResponse | null>(null);

  const fetchDashboardData = useCallback(async (isSilent = false) => {
    if (isSilent) {
      setRefreshing(true);
    } else {
      setLoading(true);
    }
    setErrorMessage(null);

    try {
      const [issuesRes, devicesRes, statsRes] = await Promise.all([
        fetch(`${API_BASE_URL}/api/v1/issues`, { cache: "no-store" }),
        fetch(`${API_BASE_URL}/api/v1/devices`, { cache: "no-store" }),
        fetch(`${API_BASE_URL}/api/v1/stats`, { cache: "no-store" }),
      ]);

      if (!issuesRes.ok || !devicesRes.ok || !statsRes.ok) {
        throw new Error("Backend API returned an unexpected response status.");
      }

      const [issuesData, devicesData, statsData]: [
        IssueRecord[],
        DeviceRecord[],
        StatsResponse,
      ] = await Promise.all([issuesRes.json(), devicesRes.json(), statsRes.json()]);

      setIssues(issuesData);
      setDevices(devicesData);
      setStats(statsData);

      setSelectedIssue((prev) => {
        if (prev) {
          const updated = issuesData.find((item) => item.id === prev.id);
          if (updated) return updated;
        }
        return issuesData.length > 0 ? issuesData[0] : null;
      });
    } catch (err) {
      setErrorMessage(
        err instanceof Error
          ? `${err.message} Verify FastAPI is running at ${API_BASE_URL}.`
          : `Unable to reach CivicWatch backend at ${API_BASE_URL}.`
      );
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    fetchDashboardData(false);
  }, [fetchDashboardData]);

  useEffect(() => {
    if (selectedIssue) {
      setCrewInput(selectedIssue.assigned_crew || "");
      setImageErrorId(null);
    }
  }, [selectedIssue]);

  useEffect(() => {
    return () => {
      if (uploadPreviewUrl) {
        URL.revokeObjectURL(uploadPreviewUrl);
      }
    };
  }, [uploadPreviewUrl]);

  const filteredIssues = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return [...issues]
      .filter((item) => {
        if (statusFilter !== "All" && item.status !== statusFilter) return false;
        if (categoryFilter !== "All" && item.category !== categoryFilter) return false;
        if (priorityFilter !== "All" && item.priority_level !== priorityFilter) return false;
        if (q) {
          const hay = `${item.title} ${item.zone} ${item.device_id} ${item.assigned_crew || ""} ${item.category}`.toLowerCase();
          if (!hay.includes(q)) return false;
        }
        return true;
      })
      .sort((a, b) => b.priority_score - a.priority_score);
  }, [issues, statusFilter, categoryFilter, priorityFilter, searchQuery]);

  const activeIssueCount = stats
    ? stats.open_issues + stats.in_progress_issues
    : issues.filter((i) => i.status === "Open" || i.status === "In Progress").length;

  const criticalAlertCount = stats
    ? stats.by_priority?.Critical ?? 0
    : issues.filter((i) => i.priority_level === "Critical" && i.status !== "Resolved").length;

  const resolvedIssueCount = stats
    ? stats.resolved_issues
    : issues.filter((i) => i.status === "Resolved").length;

  const activeDevicesCount = stats
    ? stats.devices.online
    : devices.filter((d) => d.status === "online").length;

  const totalDevicesCount = stats ? stats.devices.total : devices.length;

  async function handleUpdateIssue(
    issueId: number,
    updates: { status?: string; assigned_crew?: string }
  ) {
    setUpdatingStatus(true);
    try {
      const res = await fetch(`${API_BASE_URL}/api/v1/issues/${issueId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(updates),
      });
      if (!res.ok) {
        throw new Error("Failed to update ticket status.");
      }
      const updatedIssue: IssueRecord = await res.json();
      setIssues((prev) => prev.map((it) => (it.id === updatedIssue.id ? updatedIssue : it)));
      setSelectedIssue(updatedIssue);
      await fetchDashboardData(true);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "Failed to save issue update.");
    } finally {
      setUpdatingStatus(false);
    }
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0] || null;
    setUploadFile(file);
    setUploadError(null);
    setUploadResult(null);
    if (uploadPreviewUrl) {
      URL.revokeObjectURL(uploadPreviewUrl);
    }
    if (file) {
      setUploadPreviewUrl(URL.createObjectURL(file));
    } else {
      setUploadPreviewUrl(null);
    }
  }

  async function handleSimulateUpload(e: React.FormEvent) {
    e.preventDefault();
    if (!uploadFile) {
      setUploadError("Select a JPEG or PNG road scene image before submitting.");
      return;
    }

    const latNum = Number.parseFloat(uploadLat);
    const lonNum = Number.parseFloat(uploadLon);
    if (Number.isNaN(latNum) || latNum < -90 || latNum > 90) {
      setUploadError("Enter a valid latitude between -90 and 90.");
      return;
    }
    if (Number.isNaN(lonNum) || lonNum < -180 || lonNum > 180) {
      setUploadError("Enter a valid longitude between -180 and 180.");
      return;
    }

    setUploading(true);
    setUploadError(null);
    setUploadResult(null);

    try {
      const formData = new FormData();
      formData.append("image", uploadFile);
      formData.append("device_id", uploadDeviceId.trim() || "ESP32-CAM-SIM-01");
      formData.append("latitude", latNum.toString());
      formData.append("longitude", lonNum.toString());
      formData.append("timestamp", new Date().toISOString());

      const res = await fetch(`${API_BASE_URL}/api/v1/telemetry/ingest`, {
        method: "POST",
        body: formData,
      });

      if (!res.ok) {
        const errBody = await res.json().catch(() => null);
        throw new Error(errBody?.detail || `Telemetry ingest failed (${res.status}).`);
      }

      const data: TelemetryIngestResponse = await res.json();
      setUploadResult(data);
      await fetchDashboardData(true);
      setSelectedIssue(data.issue);
      setImageErrorId(null);
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : "Upload failed.");
    } finally {
      setUploading(false);
    }
  }

  const priorityBreakdown = useMemo(() => {
    if (!selectedIssue) return null;
    const categoryBase =
      selectedIssue.category === "pothole"
        ? 38
        : selectedIssue.category === "stagnant_water"
        ? 33
        : 27;
    const visualPts = Math.round((selectedIssue.severity_score / 100) * 27);
    const repeatPts = Math.min(20, Math.max(0, selectedIssue.report_count - 1) * 6.5);
    const contextPts = Math.max(
      0,
      Math.min(15, selectedIssue.priority_score - (categoryBase + visualPts + repeatPts))
    );
    return [
      { label: "Hazard Class Risk", score: categoryBase, max: 38 },
      { label: "Visual Severity & Confidence", score: visualPts, max: 27 },
      { label: "Repeat Telemetry Density", score: Math.round(repeatPts), max: 20 },
      { label: "Corridor Criticality & Age", score: Math.round(contextPts), max: 15 },
    ];
  }, [selectedIssue]);

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      {/* Three-Zone Municipal Command Header */}
      <header className="sticky top-0 z-30 border-b border-slate-200 bg-white/95 backdrop-blur-sm">
        <div className="mx-auto flex max-w-[1440px] items-center justify-between gap-8 px-6 py-3.5">
          <a
            href="#overview"
            className="text-lg font-bold tracking-tight text-slate-900 whitespace-nowrap shrink-0"
          >
            CivicWatch
          </a>

          <nav className="hidden md:flex items-center gap-6 text-sm font-medium text-slate-600">
            <a
              href="#overview"
              className="hover:text-slate-900 transition-colors whitespace-nowrap shrink-0"
            >
              Overview
            </a>
            <a
              href="#command-map"
              className="hover:text-slate-900 transition-colors whitespace-nowrap shrink-0"
            >
              Live Map
            </a>
            <a
              href="#tickets"
              className="hover:text-slate-900 transition-colors whitespace-nowrap shrink-0"
            >
              Issue Tickets
            </a>
            <a
              href="#fleet"
              className="hover:text-slate-900 transition-colors whitespace-nowrap shrink-0"
            >
              IoT Fleet
            </a>
          </nav>

          <div className="flex items-center gap-3 shrink-0">
            <button
              type="button"
              onClick={() => {
                setUploadError(null);
                setUploadResult(null);
                setIsUploadOpen(true);
              }}
              className="inline-flex items-center gap-2 rounded-lg bg-slate-900 px-4 py-2 text-xs font-semibold text-white transition-colors hover:bg-slate-800 whitespace-nowrap shrink-0"
            >
              <Upload className="h-3.5 w-3.5" aria-hidden="true" />
              <span>Simulate ESP32 Upload</span>
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-[1440px] space-y-6 px-6 py-6">
        {/* Page Context Row */}
        <section id="overview" className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="text-xs font-medium text-slate-500">
              NagarNetra · Bengaluru Municipal Infrastructure Operations
            </p>
            <h1 className="mt-1 text-2xl font-bold tracking-tight text-slate-900 text-balance">
              Priority Maintenance &amp; Telemetry Command
            </h1>
          </div>

          <button
            type="button"
            onClick={() => fetchDashboardData(true)}
            disabled={refreshing}
            className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3.5 py-2 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-100 disabled:opacity-60 whitespace-nowrap shrink-0"
          >
            <RefreshCw
              className={`h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`}
              aria-hidden="true"
            />
            <span>{refreshing ? "Syncing..." : "Refresh Telemetry"}</span>
          </button>
        </section>

        {/* Connection Error Banner */}
        {errorMessage && (
          <div
            role="alert"
            className="flex items-center justify-between gap-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800"
          >
            <div className="flex items-center gap-2.5">
              <AlertTriangle className="h-4 w-4 shrink-0 text-red-600" aria-hidden="true" />
              <span>{errorMessage}</span>
            </div>
            <button
              type="button"
              onClick={() => fetchDashboardData(false)}
              className="rounded-md border border-red-300 bg-white px-3 py-1 text-xs font-medium text-red-700 hover:bg-red-100 whitespace-nowrap shrink-0"
            >
              Retry
            </button>
          </div>
        )}

        {/* 4 KPI Cards */}
        <section className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div className="rounded-xl border border-slate-200 bg-white p-5">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-slate-500">Total Active Issues</span>
              <Wrench className="h-4 w-4 text-slate-400" aria-hidden="true" />
            </div>
            <p className="mt-2 font-mono text-3xl font-semibold tracking-tight text-slate-900 tabular-nums">
              {loading ? "--" : activeIssueCount}
            </p>
            <p className="mt-2 text-xs text-slate-500 tabular-nums">
              {stats?.total_reports ?? 0} raw reports · {stats?.deduplicated_merges ?? 0} spatial merges
            </p>
          </div>

          <div className="rounded-xl border border-slate-200 bg-white p-5">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-slate-500">Critical Alerts</span>
              <AlertTriangle className="h-4 w-4 text-red-600" aria-hidden="true" />
            </div>
            <p className="mt-2 font-mono text-3xl font-semibold tracking-tight text-red-700 tabular-nums">
              {loading ? "--" : criticalAlertCount}
            </p>
            <p className="mt-2 text-xs text-slate-500 tabular-nums">
              {stats?.by_priority?.High ?? 0} high priority · avg score{" "}
              {stats?.avg_priority_score ?? 0}
            </p>
          </div>

          <div className="rounded-xl border border-slate-200 bg-white p-5">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-slate-500">Resolved Issues</span>
              <CheckCircle2 className="h-4 w-4 text-emerald-600" aria-hidden="true" />
            </div>
            <p className="mt-2 font-mono text-3xl font-semibold tracking-tight text-emerald-700 tabular-nums">
              {loading ? "--" : resolvedIssueCount}
            </p>
            <p className="mt-2 text-xs text-slate-500 tabular-nums">
              {stats && stats.total_issues > 0
                ? `${Math.round((resolvedIssueCount / stats.total_issues) * 100)}% closure rate`
                : "Awaiting resolution telemetry"}
            </p>
          </div>

          <div className="rounded-xl border border-slate-200 bg-white p-5">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-slate-500">Active IoT Vehicles</span>
              <Radio className="h-4 w-4 text-blue-600" aria-hidden="true" />
            </div>
            <p className="mt-2 font-mono text-3xl font-semibold tracking-tight text-slate-900 tabular-nums">
              {loading ? "--" : `${activeDevicesCount}/${totalDevicesCount}`}
            </p>
            <p className="mt-2 text-xs text-slate-500 tabular-nums">
              ESP32-CAM + NEO-6M edge fleet online
            </p>
          </div>
        </section>

        {/* Interactive Map + Issue Detail Drawer */}
        <section
          id="command-map"
          className="grid grid-cols-1 gap-5 lg:grid-cols-12 lg:items-stretch"
        >
          {/* Interactive Map Canvas */}
          <div className="flex flex-col rounded-xl border border-slate-200 bg-white p-4 lg:col-span-7">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <div>
                <h2 className="text-base font-semibold text-slate-900">
                  Geospatial Defect Map
                </h2>
                <p className="text-xs text-slate-500">
                  {filteredIssues.length} plotted anomalies · 10m Haversine deduplication active
                </p>
              </div>
              <span className="font-mono text-xs text-slate-500 tabular-nums">
                Bengaluru Urban Grid
              </span>
            </div>

            <div className="min-h-[460px] flex-1">
              <MapComponent
                issues={filteredIssues}
                selectedIssue={selectedIssue}
                onSelectIssue={(issue: IssueRecord) => setSelectedIssue(issue)}
              />
            </div>
          </div>

          {/* Issue Detail Drawer / Inspector */}
          <aside className="flex flex-col rounded-xl border border-slate-200 bg-white p-5 lg:col-span-5">
            {selectedIssue ? (
              <div className="flex h-full flex-col justify-between gap-4">
                <div className="space-y-4">
                  {/* Header Metadata */}
                  <div className="flex items-start justify-between gap-3 border-b border-slate-100 pb-3">
                    <div className="min-w-0">
                      <p className="text-xs font-medium text-slate-500">
                        Ticket #{selectedIssue.id} ·{" "}
                        {CATEGORY_LABELS[selectedIssue.category] || selectedIssue.category} ·{" "}
                        <span className={STATUS_TEXT_COLOR[selectedIssue.status] || "text-slate-700"}>
                          {selectedIssue.status}
                        </span>
                      </p>
                      <h3 className="mt-1 text-base font-semibold leading-snug text-slate-900">
                        {selectedIssue.title}
                      </h3>
                    </div>

                    <div className="shrink-0 text-right">
                      <span
                        className={`block font-mono text-xl font-bold tabular-nums ${
                          PRIORITY_TEXT_COLOR[selectedIssue.priority_level] || "text-slate-800"
                        }`}
                      >
                        {selectedIssue.priority_score}
                      </span>
                      <span className="text-xs font-medium text-slate-500">
                        {selectedIssue.priority_level}
                      </span>
                    </div>
                  </div>

                  {/* AI-Annotated Telemetry Image */}
                  <div className="relative overflow-hidden rounded-lg border border-slate-200 bg-slate-900">
                    {imageErrorId === selectedIssue.id ? (
                      <div className="flex h-52 w-full flex-col items-center justify-center gap-2 bg-slate-900 px-4 text-center text-slate-300">
                        <Camera className="h-7 w-7 text-slate-500" aria-hidden="true" />
                        <p className="text-xs font-medium">
                          Annotated frame preview unavailable
                        </p>
                        <p className="font-mono text-[11px] text-slate-400">
                          {selectedIssue.image_url}
                        </p>
                      </div>
                    ) : (
                      <img
                        src={resolveImageUrl(selectedIssue.image_url)}
                        alt={`AI-annotated detection for ${selectedIssue.title}`}
                        referrerPolicy="no-referrer"
                        onError={() => setImageErrorId(selectedIssue.id)}
                        className="h-52 w-full object-cover"
                      />
                    )}
                    <div className="flex items-center justify-between border-t border-slate-800 bg-slate-950/90 px-3 py-1.5 text-xs text-slate-300">
                      <span className="font-mono tabular-nums">
                        CV Confidence {(selectedIssue.confidence * 100).toFixed(1)}%
                      </span>
                      <span className="font-mono tabular-nums">
                        Node {selectedIssue.device_id}
                      </span>
                    </div>
                  </div>

                  {/* Location & Google Maps Link */}
                  <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-slate-50 px-3.5 py-2.5 text-xs">
                    <div className="space-y-0.5">
                      <p className="font-medium text-slate-800">{selectedIssue.zone}</p>
                      <p className="font-mono text-slate-500 tabular-nums">
                        {selectedIssue.latitude.toFixed(6)}, {selectedIssue.longitude.toFixed(6)}
                      </p>
                    </div>
                    <a
                      href={`https://www.google.com/maps?q=${selectedIssue.latitude},${selectedIssue.longitude}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-100 whitespace-nowrap"
                    >
                      <MapPin className="h-3.5 w-3.5 text-blue-600" aria-hidden="true" />
                      <span>Google Maps</span>
                      <ExternalLink className="h-3 w-3 text-slate-400" aria-hidden="true" />
                    </a>
                  </div>

                  {/* Priority Breakdown */}
                  {priorityBreakdown && (
                    <div className="space-y-2 border-t border-slate-100 pt-3">
                      <div className="flex items-center justify-between text-xs">
                        <span className="font-semibold text-slate-700">Priority Breakdown</span>
                        <span className="font-mono text-slate-500 tabular-nums">
                          {selectedIssue.report_count} reports · {formatRelativeTime(selectedIssue.last_reported_at)}
                        </span>
                      </div>

                      <div className="space-y-2">
                        {priorityBreakdown.map((factor) => {
                          const pct = Math.min(100, Math.round((factor.score / factor.max) * 100));
                          return (
                            <div key={factor.label} className="space-y-1">
                              <div className="flex items-center justify-between text-xs text-slate-600">
                                <span>{factor.label}</span>
                                <span className="font-mono tabular-nums text-slate-800">
                                  {factor.score} / {factor.max}
                                </span>
                              </div>
                              <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
                                <div
                                  className={`h-full rounded-full ${
                                    PRIORITY_BAR_COLOR[selectedIssue.priority_level] || "bg-slate-600"
                                  }`}
                                  style={{ width: `${pct}%` }}
                                />
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {/* Crew Assignment */}
                  <div className="flex items-center gap-2 pt-1">
                    <input
                      type="text"
                      value={crewInput}
                      onChange={(e) => setCrewInput(e.target.value)}
                      placeholder="Assign municipal crew (e.g., BBMP Squad A)"
                      aria-label="Assigned municipal crew"
                      className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-900 placeholder:text-slate-400 focus:border-blue-600 focus:outline-none"
                    />
                    <button
                      type="button"
                      disabled={updatingStatus}
                      onClick={() =>
                        handleUpdateIssue(selectedIssue.id, { assigned_crew: crewInput })
                      }
                      className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-100 disabled:opacity-50 whitespace-nowrap shrink-0"
                    >
                      Assign
                    </button>
                  </div>
                </div>

                {/* Status Transition Workflow Buttons */}
                <div className="border-t border-slate-100 pt-3">
                  <p className="mb-2 text-xs font-medium text-slate-500">
                    Dispatch Workflow Status
                  </p>
                  <div className="grid grid-cols-3 gap-2">
                    {(["Open", "In Progress", "Resolved"] as const).map((nextStatus) => {
                      const isActive = selectedIssue.status === nextStatus;
                      return (
                        <button
                          key={nextStatus}
                          type="button"
                          disabled={updatingStatus || isActive}
                          onClick={() =>
                            handleUpdateIssue(selectedIssue.id, { status: nextStatus })
                          }
                          className={`rounded-lg px-3 py-2 text-xs font-semibold transition-colors whitespace-nowrap ${
                            isActive
                              ? "bg-slate-900 text-white"
                              : "border border-slate-200 bg-white text-slate-700 hover:bg-slate-100"
                          } disabled:cursor-default`}
                        >
                          {nextStatus}
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>
            ) : (
              <div className="flex h-full min-h-[420px] flex-col items-center justify-center text-center">
                <MapPin className="h-8 w-8 text-slate-300" aria-hidden="true" />
                <p className="mt-3 text-sm font-medium text-slate-700">No Ticket Selected</p>
                <p className="mt-1 max-w-xs text-xs text-slate-500">
                  Select a marker on the Bengaluru telemetry map or click any row in the priority queue below.
                </p>
              </div>
            )}
          </aside>
        </section>

        {/* Filterable Issue Tickets Table */}
        <section id="tickets" className="rounded-xl border border-slate-200 bg-white">
          <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-200 px-5 py-4">
            <div>
              <h2 className="text-base font-semibold text-slate-900">
                Priority Maintenance Queue
              </h2>
              <p className="text-xs text-slate-500">
                Sorted descending by composite 0–100 priority score
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2.5">
              {/* Segmented Status Filter */}
              <div className="flex items-center gap-1 rounded-lg bg-slate-100 p-1">
                {["All", "Open", "In Progress", "Resolved"].map((st) => (
                  <button
                    key={st}
                    type="button"
                    onClick={() => setStatusFilter(st)}
                    className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors whitespace-nowrap ${
                      statusFilter === st
                        ? "bg-white text-slate-900 shadow-sm"
                        : "text-slate-600 hover:text-slate-900"
                    }`}
                  >
                    {st}
                  </button>
                ))}
              </div>

              {/* Category Select */}
              <div className="relative flex items-center">
                <Filter className="pointer-events-none absolute left-2.5 h-3.5 w-3.5 text-slate-400" aria-hidden="true" />
                <select
                  value={categoryFilter}
                  onChange={(e) => setCategoryFilter(e.target.value)}
                  aria-label="Filter by defect category"
                  className="rounded-lg border border-slate-200 bg-white py-1.5 pl-8 pr-3 text-xs font-medium text-slate-700 focus:border-blue-600 focus:outline-none"
                >
                  <option value="All">All Categories</option>
                  <option value="pothole">Road Pothole</option>
                  <option value="stagnant_water">Stagnant Water</option>
                  <option value="illegal_garbage">Illegal Garbage</option>
                </select>
              </div>

              {/* Priority Select */}
              <select
                value={priorityFilter}
                onChange={(e) => setPriorityFilter(e.target.value)}
                aria-label="Filter by priority level"
                className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 focus:border-blue-600 focus:outline-none"
              >
                <option value="All">All Priorities</option>
                <option value="Critical">Critical</option>
                <option value="High">High</option>
                <option value="Medium">Medium</option>
                <option value="Low">Low</option>
              </select>

              {/* Search Input */}
              <div className="relative flex items-center">
                <Search className="pointer-events-none absolute left-2.5 h-3.5 w-3.5 text-slate-400" aria-hidden="true" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search zone, device, crew..."
                  aria-label="Search issue tickets"
                  className="w-48 rounded-lg border border-slate-200 bg-white py-1.5 pl-8 pr-3 text-xs text-slate-900 placeholder:text-slate-400 focus:border-blue-600 focus:outline-none"
                />
              </div>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left text-sm">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50/70 text-xs font-semibold text-slate-600">
                  <th className="px-5 py-3">Priority</th>
                  <th className="px-4 py-3">Issue &amp; Corridor</th>
                  <th className="px-4 py-3">Category</th>
                  <th className="px-4 py-3 text-right">Reports</th>
                  <th className="px-4 py-3 text-right">CV Conf.</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-5 py-3 text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {loading ? (
                  Array.from({ length: 4 }).map((_, idx) => (
                    <tr key={idx}>
                      <td colSpan={7} className="px-5 py-4">
                        <div className="h-4 w-full animate-pulse rounded bg-slate-100" />
                      </td>
                    </tr>
                  ))
                ) : filteredIssues.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="px-5 py-10 text-center">
                      <p className="text-sm font-medium text-slate-700">
                        No infrastructure tickets match your current filters
                      </p>
                      <button
                        type="button"
                        onClick={() => {
                          setStatusFilter("All");
                          setCategoryFilter("All");
                          setPriorityFilter("All");
                          setSearchQuery("");
                        }}
                        className="mt-3 rounded-lg border border-slate-200 bg-white px-3.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100"
                      >
                        Reset Filters
                      </button>
                    </td>
                  </tr>
                ) : (
                  filteredIssues.map((issue) => {
                    const isSelected = selectedIssue?.id === issue.id;
                    return (
                      <tr
                        key={issue.id}
                        onClick={() => setSelectedIssue(issue)}
                        className={`cursor-pointer transition-colors hover:bg-slate-50 ${
                          isSelected ? "bg-blue-50/50" : ""
                        }`}
                      >
                        <td className="px-5 py-3.5 whitespace-nowrap">
                          <span
                            className={`font-mono text-sm font-bold tabular-nums ${
                              PRIORITY_TEXT_COLOR[issue.priority_level] || "text-slate-700"
                            }`}
                          >
                            {issue.priority_score}
                          </span>
                          <span className="ml-2 text-xs font-medium text-slate-500">
                            {issue.priority_level}
                          </span>
                        </td>
                        <td className="px-4 py-3.5">
                          <p className="font-medium text-slate-900">{issue.title}</p>
                          <p className="mt-0.5 text-xs text-slate-500">
                            {issue.zone} · <span className="font-mono">{issue.device_id}</span>
                            {issue.assigned_crew ? ` · ${issue.assigned_crew}` : ""}
                          </p>
                        </td>
                        <td className="px-4 py-3.5 text-xs text-slate-700 whitespace-nowrap">
                          {CATEGORY_LABELS[issue.category] || issue.category}
                        </td>
                        <td className="px-4 py-3.5 text-right font-mono text-xs font-semibold text-slate-800 tabular-nums">
                          {issue.report_count}
                        </td>
                        <td className="px-4 py-3.5 text-right font-mono text-xs text-slate-700 tabular-nums">
                          {(issue.confidence * 100).toFixed(0)}%
                        </td>
                        <td className="px-4 py-3.5 whitespace-nowrap">
                          <span
                            className={`text-xs font-semibold ${
                              STATUS_TEXT_COLOR[issue.status] || "text-slate-600"
                            }`}
                          >
                            {issue.status}
                          </span>
                        </td>
                        <td className="px-5 py-3.5 text-right whitespace-nowrap">
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              setSelectedIssue(issue);
                            }}
                            className="rounded-md border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-100"
                          >
                            Inspect
                          </button>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </section>

        {/* IoT Edge Fleet Overview */}
        <section id="fleet" className="rounded-xl border border-slate-200 bg-white p-5">
          <div className="mb-4 flex items-center justify-between">
            <div>
              <h2 className="text-base font-semibold text-slate-900">
                Connected ESP32-CAM &amp; GPS Telemetry Nodes
              </h2>
              <p className="text-xs text-slate-500">
                Live edge units transmitting frames and NEO-6M GPS coordinates
              </p>
            </div>
            <span className="font-mono text-xs text-slate-500 tabular-nums">
              {activeDevicesCount} online · {devices.length - activeDevicesCount} offline
            </span>
          </div>

          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-4">
            {devices.map((dev) => {
              const isOnline = dev.status === "online";
              return (
                <div
                  key={dev.device_id}
                  className="rounded-lg border border-slate-200 bg-slate-50/50 p-3.5"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono text-xs font-semibold text-slate-900">
                      {dev.device_id}
                    </span>
                    <span
                      className={`text-xs font-semibold ${
                        isOnline ? "text-emerald-700" : "text-slate-500"
                      }`}
                    >
                      {isOnline ? "Online" : "Offline"}
                    </span>
                  </div>
                  <p className="mt-1 truncate text-xs font-medium text-slate-700">{dev.name}</p>
                  <p className="mt-1 text-xs text-slate-500">
                    {dev.zone} · <span className="font-mono tabular-nums">{dev.total_uploads}</span>{" "}
                    uploads
                  </p>
                  <p className="mt-1 font-mono text-[11px] text-slate-400 tabular-nums">
                    Last seen {formatRelativeTime(dev.last_seen)} · {dev.firmware_version}
                  </p>
                </div>
              );
            })}
          </div>
        </section>
      </main>

      {/* Simulate ESP32 Upload Modal */}
      {isUploadOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="simulate-upload-title"
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 p-4 backdrop-blur-xs"
        >
          <div className="w-full max-w-lg rounded-xl border border-slate-200 bg-white shadow-xl">
            <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
              <div>
                <h2 id="simulate-upload-title" className="text-base font-semibold text-slate-900">
                  Simulate ESP32-CAM Telemetry Upload
                </h2>
                <p className="text-xs text-slate-500">
                  Submit a test photo and GPS fix to run live OpenCV detection &amp; deduplication
                </p>
              </div>
              <button
                type="button"
                onClick={() => setIsUploadOpen(false)}
                aria-label="Close modal"
                className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
              >
                <X className="h-4 w-4" aria-hidden="true" />
              </button>
            </div>

            <form onSubmit={handleSimulateUpload} className="space-y-4 px-5 py-4">
              {/* Image Picker */}
              <div>
                <label className="mb-1.5 block text-xs font-medium text-slate-700">
                  Road / Infrastructure Scene Image (JPEG, PNG)
                </label>
                <label className="flex cursor-pointer flex-col items-center justify-center rounded-lg border border-dashed border-slate-300 bg-slate-50 px-4 py-5 text-center transition-colors hover:border-slate-400 hover:bg-slate-100">
                  {uploadPreviewUrl ? (
                    <img
                      src={uploadPreviewUrl}
                      alt="Selected telemetry preview"
                      className="max-h-40 rounded-md object-contain"
                    />
                  ) : (
                    <>
                      <Camera className="h-6 w-6 text-slate-400" aria-hidden="true" />
                      <span className="mt-2 text-xs font-medium text-slate-700">
                        Click to choose an image frame
                      </span>
                      <span className="mt-0.5 text-[11px] text-slate-500">
                        Multipart POST to /api/v1/telemetry/ingest
                      </span>
                    </>
                  )}
                  <input
                    type="file"
                    accept="image/*"
                    onChange={handleFileChange}
                    className="sr-only"
                  />
                </label>
              </div>

              {/* Device ID */}
              <div>
                <label
                  htmlFor="sim-device-id"
                  className="mb-1 block text-xs font-medium text-slate-700"
                >
                  ESP32 Device ID
                </label>
                <input
                  id="sim-device-id"
                  type="text"
                  value={uploadDeviceId}
                  onChange={(e) => setUploadDeviceId(e.target.value)}
                  className="w-full rounded-lg border border-slate-200 px-3 py-2 font-mono text-xs text-slate-900 focus:border-blue-600 focus:outline-none"
                />
              </div>

              {/* GPS Coordinates + Bengaluru Quick Presets */}
              <div className="space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-xs font-medium text-slate-700">GPS Coordinates</span>
                  <div className="flex flex-wrap items-center gap-1.5">
                    {BENGALURU_PRESETS.map((preset) => (
                      <button
                        key={preset.label}
                        type="button"
                        onClick={() => {
                          setUploadLat(preset.lat);
                          setUploadLon(preset.lon);
                        }}
                        className="rounded border border-slate-200 bg-slate-50 px-2 py-0.5 text-[11px] font-medium text-slate-600 hover:bg-slate-100"
                      >
                        {preset.label}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label htmlFor="sim-lat" className="mb-1 block text-[11px] text-slate-500">
                      Latitude
                    </label>
                    <input
                      id="sim-lat"
                      type="text"
                      value={uploadLat}
                      onChange={(e) => setUploadLat(e.target.value)}
                      className="w-full rounded-lg border border-slate-200 px-3 py-2 font-mono text-xs text-slate-900 tabular-nums focus:border-blue-600 focus:outline-none"
                    />
                  </div>
                  <div>
                    <label htmlFor="sim-lon" className="mb-1 block text-[11px] text-slate-500">
                      Longitude
                    </label>
                    <input
                      id="sim-lon"
                      type="text"
                      value={uploadLon}
                      onChange={(e) => setUploadLon(e.target.value)}
                      className="w-full rounded-lg border border-slate-200 px-3 py-2 font-mono text-xs text-slate-900 tabular-nums focus:border-blue-600 focus:outline-none"
                    />
                  </div>
                </div>
              </div>

              {uploadError && (
                <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
                  {uploadError}
                </p>
              )}

              {uploadResult && (
                <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-xs text-emerald-900">
                  <p className="font-semibold">
                    {uploadResult.deduplicated
                      ? `Merged into Ticket #${uploadResult.issue.id} (${uploadResult.distance_meters}m from existing site)`
                      : `Created New Ticket #${uploadResult.issue.id}`}
                  </p>
                  <p className="mt-1 font-mono text-[11px] text-emerald-800">
                    Category: {uploadResult.issue.category} · Priority:{" "}
                    {uploadResult.issue.priority_level} ({uploadResult.issue.priority_score}/100) ·{" "}
                    {uploadResult.inference_ms} ms
                  </p>
                </div>
              )}

              <div className="flex items-center justify-end gap-2.5 border-t border-slate-100 pt-3">
                <button
                  type="button"
                  onClick={() => setIsUploadOpen(false)}
                  className="rounded-lg border border-slate-200 bg-white px-4 py-2 text-xs font-medium text-slate-700 hover:bg-slate-100"
                >
                  Close
                </button>
                <button
                  type="submit"
                  disabled={uploading}
                  className="inline-flex items-center gap-2 rounded-lg bg-slate-900 px-4 py-2 text-xs font-semibold text-white hover:bg-slate-800 disabled:opacity-60"
                >
                  {uploading ? (
                    <>
                      <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                      <span>Running CV Inference...</span>
                    </>
                  ) : (
                    <>
                      <Upload className="h-3.5 w-3.5" aria-hidden="true" />
                      <span>Transmit Telemetry</span>
                    </>
                  )}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
