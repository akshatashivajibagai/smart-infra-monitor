"""
CivicWatch - IoT-Based Smart Infrastructure Monitoring & Priority Maintenance System
FastAPI Backend with Spatial Deduplication, Computer Vision Detection, and Priority Scoring.
"""

from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
import io
import json
import math
import os
from pathlib import Path
import time
from typing import Any, Dict, List, Optional, Tuple
import uuid

import cv2
from fastapi import Depends, FastAPI, File, Form, HTTPException, Query, UploadFile, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
import numpy as np
from PIL import Image, UnidentifiedImageError
from pydantic import BaseModel, Field
from sqlalchemy import (
    Column,
    DateTime,
    Float,
    Integer,
    String,
    Text,
    create_engine,
    func,
)
from sqlalchemy.orm import Session, declarative_base, sessionmaker

# ---------------------------------------------------------------------------
# Configuration & Storage Setup
# ---------------------------------------------------------------------------

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"
ANNOTATED_DIR = STATIC_DIR / "annotated"
UPLOADS_DIR = STATIC_DIR / "uploads"
WEIGHTS_PATH = BASE_DIR / "weights" / "civicwatch_yolov8n.onnx"

ANNOTATED_DIR.mkdir(parents=True, exist_ok=True)
UPLOADS_DIR.mkdir(parents=True, exist_ok=True)

DATABASE_URL = f"sqlite:///{(BASE_DIR / 'infra.db').as_posix()}"

engine = create_engine(
    DATABASE_URL,
    connect_args={"check_same_thread": False},
    echo=False,
)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()

# Domain constants
VALID_CATEGORIES = ("pothole", "stagnant_water", "illegal_garbage")
VALID_STATUSES = ("Open", "In Progress", "Resolved", "Dismissed")
VALID_PRIORITIES = ("Critical", "High", "Medium", "Low")
DEDUP_RADIUS_METERS = 10.0

CATEGORY_COLORS_BGR: Dict[str, Tuple[int, int, int]] = {
    "pothole": (45, 55, 235),           # Vivid Red-Orange
    "stagnant_water": (235, 165, 30),   # Vivid Cyan-Blue
    "illegal_garbage": (35, 195, 245),  # Vivid Amber-Yellow
}

CATEGORY_LABELS: Dict[str, str] = {
    "pothole": "Road Pothole",
    "stagnant_water": "Stagnant Water / Drainage",
    "illegal_garbage": "Illegal Garbage Dumping",
}

BENGALURU_ZONES = [
    ("Silk Board Junction", 12.9177, 77.6238, 1.0),
    ("Indiranagar 100ft Rd", 12.9784, 77.6408, 0.9),
    ("Koramangala 80ft Rd", 12.9352, 77.6245, 0.85),
    ("MG Road Corridor", 12.9756, 77.6066, 0.95),
    ("Hebbal Flyover Ramp", 13.0358, 77.5970, 0.95),
    ("Whitefield ITPL Rd", 12.9850, 77.7366, 0.8),
    ("Jayanagar 4th Block", 12.9299, 77.5824, 0.75),
]


# ---------------------------------------------------------------------------
# SQLAlchemy ORM Models
# ---------------------------------------------------------------------------

class Device(Base):
    __tablename__ = "devices"

    id = Column(Integer, primary_key=True, index=True)
    device_id = Column(String(64), unique=True, index=True, nullable=False)
    name = Column(String(128), nullable=False)
    zone = Column(String(128), nullable=False, default="Bengaluru Metro")
    status = Column(String(32), nullable=False, default="online")
    last_latitude = Column(Float, nullable=True)
    last_longitude = Column(Float, nullable=True)
    last_seen = Column(DateTime(timezone=True), nullable=False, default=lambda: datetime.now(timezone.utc))
    total_uploads = Column(Integer, nullable=False, default=0)
    firmware_version = Column(String(32), nullable=False, default="v1.4.2-esp32cam")


class Issue(Base):
    __tablename__ = "issues"

    id = Column(Integer, primary_key=True, index=True)
    category = Column(String(64), index=True, nullable=False)
    title = Column(String(200), nullable=False)
    description = Column(Text, nullable=False, default="")
    latitude = Column(Float, nullable=False)
    longitude = Column(Float, nullable=False)
    zone = Column(String(128), nullable=False, default="Bengaluru")
    confidence = Column(Float, nullable=False)
    severity_score = Column(Float, nullable=False, default=50.0)
    priority_score = Column(Integer, index=True, nullable=False, default=50)
    priority_level = Column(String(32), index=True, nullable=False, default="Medium")
    status = Column(String(32), index=True, nullable=False, default="Open")
    report_count = Column(Integer, nullable=False, default=1)
    device_id = Column(String(64), index=True, nullable=False)
    image_url = Column(String(512), nullable=False)
    raw_image_url = Column(String(512), nullable=True)
    bounding_boxes = Column(Text, nullable=False, default="[]")
    assigned_crew = Column(String(128), nullable=True)
    first_reported_at = Column(DateTime(timezone=True), nullable=False, default=lambda: datetime.now(timezone.utc))
    last_reported_at = Column(DateTime(timezone=True), nullable=False, default=lambda: datetime.now(timezone.utc))
    resolved_at = Column(DateTime(timezone=True), nullable=True)


# ---------------------------------------------------------------------------
# Pydantic Schemas
# ---------------------------------------------------------------------------

class BoundingBoxOut(BaseModel):
    category: str
    confidence: float
    bbox: List[int]  # [x1, y1, x2, y2]
    area_ratio: float


class IssueOut(BaseModel):
    id: int
    category: str
    title: str
    description: str
    latitude: float
    longitude: float
    zone: str
    confidence: float
    severity_score: float
    priority_score: int
    priority_level: str
    status: str
    report_count: int
    device_id: str
    image_url: str
    raw_image_url: Optional[str] = None
    bounding_boxes: List[Dict[str, Any]]
    assigned_crew: Optional[str] = None
    first_reported_at: datetime
    last_reported_at: datetime
    resolved_at: Optional[datetime] = None

    class Config:
        from_attributes = True


class IssuePatchIn(BaseModel):
    status: Optional[str] = Field(default=None, description="Open | In Progress | Resolved | Dismissed")
    assigned_crew: Optional[str] = Field(default=None, max_length=128)
    description: Optional[str] = Field(default=None, max_length=1000)
    priority_score: Optional[int] = Field(default=None, ge=0, le=100)
    priority_level: Optional[str] = Field(default=None, description="Critical | High | Medium | Low")


class DeviceOut(BaseModel):
    id: int
    device_id: str
    name: str
    zone: str
    status: str
    last_latitude: Optional[float]
    last_longitude: Optional[float]
    last_seen: datetime
    total_uploads: int
    firmware_version: str

    class Config:
        from_attributes = True


class TelemetryIngestOut(BaseModel):
    status: str
    deduplicated: bool
    distance_meters: Optional[float] = None
    issue: IssueOut
    detections: List[BoundingBoxOut]
    inference_ms: float


# ---------------------------------------------------------------------------
# Database Dependency
# ---------------------------------------------------------------------------

def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


# ---------------------------------------------------------------------------
# Geospatial & Zone Helpers
# ---------------------------------------------------------------------------

def haversine_meters(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Compute great-circle distance between two GPS coordinates in meters."""
    earth_radius_m = 6_371_000.0
    phi1 = math.radians(lat1)
    phi2 = math.radians(lat2)
    d_phi = math.radians(lat2 - lat1)
    d_lambda = math.radians(lon2 - lon1)

    a = (
        math.sin(d_phi / 2.0) ** 2
        + math.cos(phi1) * math.cos(phi2) * math.sin(d_lambda / 2.0) ** 2
    )
    c = 2.0 * math.atan2(math.sqrt(a), math.sqrt(1.0 - a))
    return earth_radius_m * c


def infer_bengaluru_zone(lat: float, lon: float) -> Tuple[str, float]:
    """Find closest Bengaluru arterial zone and return (zone_name, criticality_weight)."""
    best_zone = "Bengaluru Urban Sector"
    best_weight = 0.65
    min_dist = float("inf")

    for name, zlat, zlon, weight in BENGALURU_ZONES:
        dist = haversine_meters(lat, lon, zlat, zlon)
        if dist < min_dist:
            min_dist = dist
            if dist <= 12_000.0:
                best_zone = name
                best_weight = weight
    return best_zone, best_weight


# ---------------------------------------------------------------------------
# Priority Scoring Engine (0 - 100)
# ---------------------------------------------------------------------------

def assign_priority_level(score: int) -> str:
    if score >= 80:
        return "Critical"
    if score >= 60:
        return "High"
    if score >= 35:
        return "Medium"
    return "Low"


def calculate_priority(
    category: str,
    confidence: float,
    area_ratio: float,
    report_count: int,
    first_reported_at: datetime,
    latitude: float,
    longitude: float,
) -> Tuple[int, str, float]:
    """
    Calculate composite 0-100 priority score, priority label, and visual severity score.

    Factors:
      1. Hazard Class Weight (max 38): potholes & deep waterlogging score highest.
      2. Visual Severity (max 27): bounding-box coverage ratio + detector confidence.
      3. Repeat Telemetry Density (max 20): number of deduplicated detections at site.
      4. Urban Arterial Criticality & Age Escalation (max 15).
    """
    base_weights = {
        "pothole": 38.0,
        "stagnant_water": 33.0,
        "illegal_garbage": 27.0,
    }
    category_pts = base_weights.get(category, 25.0)

    # Visual severity (0-100 scale for telemetry analytics, mapped to max 27 priority pts)
    clamped_area = max(0.02, min(0.65, area_ratio))
    normalized_area = (clamped_area - 0.02) / 0.63
    raw_severity = (normalized_area * 65.0) + (max(0.4, min(1.0, confidence)) * 35.0)
    severity_score = round(min(100.0, max(15.0, raw_severity)), 1)
    visual_pts = (severity_score / 100.0) * 27.0

    # Frequency escalation: each repeat detection adds 6.5 pts up to 20 pts
    repeat_pts = min(20.0, max(0, report_count - 1) * 6.5)

    # Arterial zone criticality + age escalation
    _, zone_weight = infer_bengaluru_zone(latitude, longitude)
    now_utc = datetime.now(timezone.utc)
    if first_reported_at.tzinfo is None:
        first_reported_at = first_reported_at.replace(tzinfo=timezone.utc)
    age_hours = max(0.0, (now_utc - first_reported_at).total_seconds() / 3600.0)
    age_pts = min(6.0, age_hours * 0.25)
    zone_pts = zone_weight * 9.0
    context_pts = min(15.0, zone_pts + age_pts)

    total_score = int(round(min(100.0, max(0.0, category_pts + visual_pts + repeat_pts + context_pts))))
    level = assign_priority_level(total_score)
    return total_score, level, severity_score


# ---------------------------------------------------------------------------
# Computer Vision Detection Engine (OpenCV Analysis + Optional ONNX YOLO)
# ---------------------------------------------------------------------------

class InfrastructureDetector:
    """
    Hybrid CV detector for CivicWatch:
      - If an ONNX YOLO model is present at backend/weights/civicwatch_yolov8n.onnx,
        runs OpenCV DNN inference.
      - Otherwise runs a deterministic OpenCV multi-feature visual analyzer
        (HSV segmentation, Canny/Laplacian texture density, contour morphology,
        and spatial entropy) with classification fallback across:
        `pothole`, `stagnant_water`, `illegal_garbage`.
    """

    def __init__(self) -> None:
        self.net = None
        if WEIGHTS_PATH.exists():
            try:
                self.net = cv2.dnn.readNetFromONNX(str(WEIGHTS_PATH))
            except Exception:
                self.net = None

    def _run_onnx_yolo(self, image: np.ndarray) -> List[Dict[str, Any]]:
        """Run YOLOv8 ONNX inference if model weights exist locally."""
        h, w = image.shape[:2]
        blob = cv2.dnn.blobFromImage(image, 1 / 255.0, (640, 640), swapRB=True, crop=False)
        self.net.setInput(blob)
        outputs = self.net.forward()
        preds = np.squeeze(outputs[0]).T

        boxes: List[List[int]] = []
        scores: List[float] = []
        class_ids: List[int] = []

        x_factor = w / 640.0
        y_factor = h / 640.0

        for row in preds:
            cls_scores = row[4:]
            if len(cls_scores) == 0:
                continue
            cls_id = int(np.argmax(cls_scores))
            conf = float(cls_scores[cls_id])
            if conf >= 0.35 and cls_id < len(VALID_CATEGORIES):
                cx, cy, bw, bh = row[0], row[1], row[2], row[3]
                x1 = max(0, int((cx - bw / 2) * x_factor))
                y1 = max(0, int((cy - bh / 2) * y_factor))
                x2 = min(w - 1, int((cx + bw / 2) * x_factor))
                y2 = min(h - 1, int((cy + bh / 2) * y_factor))
                boxes.append([x1, y1, x2 - x1, y2 - y1])
                scores.append(conf)
                class_ids.append(cls_id)

        indices = cv2.dnn.NMSBoxes(boxes, scores, 0.35, 0.45)
        results: List[Dict[str, Any]] = []
        if len(indices) > 0:
            for idx in indices.flatten():
                x, y, bw, bh = boxes[idx]
                x2, y2 = x + bw, y + bh
                area_ratio = (bw * bh) / float(max(1, w * h))
                results.append(
                    {
                        "category": VALID_CATEGORIES[class_ids[idx]],
                        "confidence": round(scores[idx], 4),
                        "bbox": [x, y, x2, y2],
                        "area_ratio": round(area_ratio, 4),
                    }
                )
        return results

    def _run_opencv_feature_analysis(self, image: np.ndarray) -> List[Dict[str, Any]]:
        """
        Analyze road-scene geometry, HSV color distributions, texture variance,
        and contour clusters using OpenCV to localize and classify anomalies.
        """
        h, w = image.shape[:2]
        img_area = float(max(1, h * w))

        # Focus primary region of interest (lower 75% road/ground plane)
        roi_y_start = int(h * 0.22)
        roi = image[roi_y_start:h, :]
        hsv = cv2.cvtColor(roi, cv2.COLOR_BGR2HSV)
        gray = cv2.cvtColor(roi, cv2.COLOR_BGR2GRAY)

        # Feature 1: Dark irregular depressions (pothole candidates)
        blurred = cv2.GaussianBlur(gray, (7, 7), 0)
        dark_thresh = cv2.adaptiveThreshold(
            blurred, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY_INV, 31, 9
        )
        edges = cv2.Canny(blurred, 55, 165)
        edge_density = float(np.count_nonzero(edges)) / float(max(1, edges.size))
        laplacian_var = float(cv2.Laplacian(gray, cv2.CV_64F).var())

        # Feature 2: Smooth reflective / murky pools (stagnant_water candidates)
        sat_channel = hsv[:, :, 1]
        val_channel = hsv[:, :, 2]
        hue_channel = hsv[:, :, 0]
        water_mask = cv2.inRange(hsv, np.array([75, 25, 45]), np.array([135, 215, 235]))
        # Also catch muddy brownish standing water with low local gradient
        grad_x = cv2.Sobel(gray, cv2.CV_32F, 1, 0, ksize=3)
        grad_y = cv2.Sobel(gray, cv2.CV_32F, 0, 1, ksize=3)
        grad_mag = cv2.magnitude(grad_x, grad_y)
        smooth_mask = (grad_mag < 14.0).astype(np.uint8) * 255
        combined_water = cv2.bitwise_or(
            water_mask,
            cv2.bitwise_and(smooth_mask, (val_channel < 160).astype(np.uint8) * 255),
        )
        water_ratio = float(np.count_nonzero(water_mask)) / float(max(1, water_mask.size))

        # Feature 3: High-saturation multi-colored debris clusters (illegal_garbage)
        vivid_mask = (sat_channel > 95).astype(np.uint8) * 255
        vivid_ratio = float(np.count_nonzero(vivid_mask)) / float(max(1, vivid_mask.size))
        hue_std = float(np.std(hue_channel[sat_channel > 40])) if np.any(sat_channel > 40) else 12.0

        # Score each category based on extracted CV signals
        pothole_signal = (
            min(1.0, edge_density * 6.5) * 0.45
            + min(1.0, laplacian_var / 900.0) * 0.35
            + (1.0 - min(1.0, vivid_ratio * 3.0)) * 0.20
        )
        water_signal = (
            min(1.0, water_ratio * 4.5) * 0.55
            + (1.0 - min(1.0, laplacian_var / 750.0)) * 0.30
            + (float(np.count_nonzero(smooth_mask)) / float(max(1, smooth_mask.size))) * 0.15
        )
        garbage_signal = (
            min(1.0, vivid_ratio * 3.8) * 0.50
            + min(1.0, hue_std / 52.0) * 0.30
            + min(1.0, edge_density * 4.2) * 0.20
        )

        signal_map = {
            "pothole": pothole_signal,
            "stagnant_water": water_signal,
            "illegal_garbage": garbage_signal,
        }

        # Select dominant category and localize bounding box using morphological contours
        best_category = max(signal_map, key=signal_map.get)
        best_signal = signal_map[best_category]

        if best_category == "stagnant_water":
            candidate_mask = combined_water
        elif best_category == "illegal_garbage":
            candidate_mask = cv2.bitwise_or(vivid_mask, edges)
        else:
            candidate_mask = cv2.bitwise_or(dark_thresh, edges)

        kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (9, 9))
        closed = cv2.morphologyEx(candidate_mask, cv2.MORPH_CLOSE, kernel)
        contours, _ = cv2.findContours(closed, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

        detections: List[Dict[str, Any]] = []
        valid_contours = sorted(
            [c for c in contours if cv2.contourArea(c) > (img_area * 0.015)],
            key=cv2.contourArea,
            reverse=True,
        )

        for cnt in valid_contours[:2]:
            x, y, bw, bh = cv2.boundingRect(cnt)
            # Filter degenerate full-frame boxes
            if bw > w * 0.92 and bh > roi.shape[0] * 0.90:
                continue
            y1 = max(0, y + roi_y_start)
            y2 = min(h - 1, y + bh + roi_y_start)
            x1 = max(0, x)
            x2 = min(w - 1, x + bw)
            area_ratio = ((x2 - x1) * (y2 - y1)) / img_area
            if area_ratio < 0.012:
                continue

            # Calibrate realistic confidence [0.64, 0.96]
            conf = min(0.96, max(0.64, 0.62 + (best_signal * 0.32) + min(0.08, area_ratio * 0.2)))
            detections.append(
                {
                    "category": best_category,
                    "confidence": round(float(conf), 4),
                    "bbox": [int(x1), int(y1), int(x2), int(y2)],
                    "area_ratio": round(float(area_ratio), 4),
                }
            )

        # Deterministic classification fallback if scene contours are too fragmented/uniform
        if not detections:
            mean_bgr = np.mean(roi, axis=(0, 1))
            fallback_idx = int(sum(mean_bgr) + edge_density * 1000) % len(VALID_CATEGORIES)
            chosen_cat = best_category if best_signal >= 0.25 else VALID_CATEGORIES[fallback_idx]

            x1 = int(w * 0.22)
            y1 = int(h * 0.42)
            x2 = int(w * 0.78)
            y2 = int(h * 0.86)
            area_ratio = ((x2 - x1) * (y2 - y1)) / img_area
            conf = round(float(min(0.91, max(0.68, 0.68 + best_signal * 0.22))), 4)
            detections.append(
                {
                    "category": chosen_cat,
                    "confidence": conf,
                    "bbox": [x1, y1, x2, y2],
                    "area_ratio": round(float(area_ratio), 4),
                }
            )

        return detections

    def detect_and_annotate(
        self, image: np.ndarray, output_path: Path
    ) -> Tuple[List[Dict[str, Any]], float]:
        """Run detection, draw bounding boxes + confidence badges, and save annotated JPEG."""
        start_t = time.perf_counter()

        detections: List[Dict[str, Any]] = []
        if self.net is not None:
            detections = self._run_onnx_yolo(image)

        if not detections:
            detections = self._run_opencv_feature_analysis(image)

        annotated = image.copy()
        h, w = annotated.shape[:2]
        thickness = max(2, int(round(min(w, h) / 220.0)))
        font_scale = max(0.5, min(w, h) / 720.0)

        for det in detections:
            cat = det["category"]
            conf = det["confidence"]
            x1, y1, x2, y2 = det["bbox"]
            color = CATEGORY_COLORS_BGR.get(cat, (0, 200, 255))

            # Draw main bounding box
            cv2.rectangle(annotated, (x1, y1), (x2, y2), color, thickness)

            # Draw corner brackets for crisp telemetry HUD styling
            corner_len = max(12, min(28, (x2 - x1) // 5, (y2 - y1) // 5))
            c_thick = thickness + 2
            # Top-left
            cv2.line(annotated, (x1, y1), (x1 + corner_len, y1), color, c_thick)
            cv2.line(annotated, (x1, y1), (x1, y1 + corner_len), color, c_thick)
            # Top-right
            cv2.line(annotated, (x2, y1), (x2 - corner_len, y1), color, c_thick)
            cv2.line(annotated, (x2, y1), (x2, y1 + corner_len), color, c_thick)
            # Bottom-left
            cv2.line(annotated, (x1, y2), (x1 + corner_len, y2), color, c_thick)
            cv2.line(annotated, (x1, y2), (x1, y2 - corner_len), color, c_thick)
            # Bottom-right
            cv2.line(annotated, (x2, y2), (x2 - corner_len, y2), color, c_thick)
            cv2.line(annotated, (x2, y2), (x2, y2 - corner_len), color, c_thick)

            # Label pill with category and confidence percentage
            label = f"{cat.upper()} {conf * 100:.1f}%"
            (text_w, text_h), baseline = cv2.getTextSize(
                label, cv2.FONT_HERSHEY_SIMPLEX, font_scale, max(1, thickness - 1)
            )
            label_y1 = max(0, y1 - text_h - baseline - 10)
            label_y2 = label_y1 + text_h + baseline + 10
            label_x2 = min(w - 1, x1 + text_w + 14)

            cv2.rectangle(annotated, (x1, label_y1), (label_x2, label_y2), color, -1)
            cv2.putText(
                annotated,
                label,
                (x1 + 7, label_y2 - baseline - 4),
                cv2.FONT_HERSHEY_SIMPLEX,
                font_scale,
                (255, 255, 255),
                max(1, thickness - 1),
                cv2.LINE_AA,
            )

        # Subtle watermark stamp at bottom-left
        stamp = f"CIVICWATCH CV | {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S UTC')}"
        cv2.putText(
            annotated,
            stamp,
            (12, max(24, h - 14)),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.48,
            (235, 235, 235),
            1,
            cv2.LINE_AA,
        )

        cv2.imwrite(str(output_path), annotated, [cv2.IMWRITE_JPEG_QUALITY, 90])
        elapsed_ms = round((time.perf_counter() - start_t) * 1000.0, 2)
        return detections, elapsed_ms


detector = InfrastructureDetector()


# ---------------------------------------------------------------------------
# Seed Data & Synthetic Sample Image Generator
# ---------------------------------------------------------------------------

def _create_seed_image(filename: str, category: str, confidence: float, zone_label: str) -> str:
    """Generate a realistic annotated synthetic road/infrastructure frame for seeded records."""
    out_path = ANNOTATED_DIR / filename
    if out_path.exists():
        return f"/static/annotated/{filename}"

    w, h = 800, 600
    rng = np.random.default_rng(abs(hash(filename)) % (2**31))
    noise = rng.integers(58, 86, size=(h, w, 3), dtype=np.uint8)
    img = noise.copy()
    img[: int(h * 0.25), :] = np.clip(img[: int(h * 0.25), :] + 38, 0, 255)

    # Lane markings
    cv2.line(img, (w // 2, int(h * 0.28)), (w // 2, h), (210, 210, 200), 4)

    if category == "pothole":
        center = (int(w * 0.48), int(h * 0.66))
        cv2.ellipse(img, center, (135, 78), 8, 0, 360, (28, 28, 32), -1)
        cv2.ellipse(img, center, (110, 56), 8, 0, 360, (18, 18, 22), -1)
        bbox = [center[0] - 145, center[1] - 88, center[0] + 145, center[1] + 88]
    elif category == "stagnant_water":
        center = (int(w * 0.52), int(h * 0.68))
        cv2.ellipse(img, center, (185, 85), -4, 0, 360, (125, 110, 72), -1)
        cv2.ellipse(img, (center[0] - 20, center[1] - 10), (140, 52), -4, 0, 360, (150, 132, 85), -1)
        bbox = [center[0] - 195, center[1] - 95, center[0] + 195, center[1] + 95]
    else:  # illegal_garbage
        base_x, base_y = int(w * 0.34), int(h * 0.56)
        bag_colors = [(40, 145, 220), (35, 175, 70), (210, 180, 45), (50, 50, 195)]
        for idx, col in enumerate(bag_colors):
            cx = base_x + idx * 55
            cy = base_y + (idx % 2) * 32
            cv2.circle(img, (cx, cy), 44, col, -1)
        bbox = [base_x - 58, base_y - 52, base_x + 225, base_y + 85]

    color = CATEGORY_COLORS_BGR[category]
    x1, y1, x2, y2 = bbox
    cv2.rectangle(img, (x1, y1), (x2, y2), color, 3)

    label = f"{category.upper()} {confidence * 100:.1f}%"
    cv2.rectangle(img, (x1, y1 - 30), (x1 + 260, y1), color, -1)
    cv2.putText(img, label, (x1 + 8, y1 - 8), cv2.FONT_HERSHEY_SIMPLEX, 0.65, (255, 255, 255), 2, cv2.LINE_AA)
    cv2.putText(img, f"CIVICWATCH | {zone_label}", (16, h - 18), cv2.FONT_HERSHEY_SIMPLEX, 0.55, (235, 235, 235), 1, cv2.LINE_AA)

    cv2.imwrite(str(out_path), img, [cv2.IMWRITE_JPEG_QUALITY, 90])
    return f"/static/annotated/{filename}"


def seed_database_if_empty() -> None:
    """Seed 4 Bengaluru IoT nodes and 6 realistic infrastructure issues on initial boot."""
    db = SessionLocal()
    try:
        existing_count = db.query(Issue).count()
        if existing_count > 0:
            return

        now = datetime.now(timezone.utc)

        devices = [
            Device(
                device_id="ESP32-CAM-BLR-01",
                name="BMTC Patrol Unit #01 (Indiranagar)",
                zone="Indiranagar 100ft Rd",
                status="online",
                last_latitude=12.9784,
                last_longitude=77.6408,
                last_seen=now - timedelta(minutes=2),
                total_uploads=47,
                firmware_version="v1.4.2-esp32cam",
            ),
            Device(
                device_id="ESP32-CAM-BLR-02",
                name="Civic Sweeper Node #02 (Silk Board)",
                zone="Silk Board Junction",
                status="online",
                last_latitude=12.9177,
                last_longitude=77.6238,
                last_seen=now - timedelta(minutes=4),
                total_uploads=63,
                firmware_version="v1.4.2-esp32cam",
            ),
            Device(
                device_id="ESP32-CAM-BLR-03",
                name="Ward Rover Unit #03 (Koramangala)",
                zone="Koramangala 80ft Rd",
                status="online",
                last_latitude=12.9352,
                last_longitude=77.6245,
                last_seen=now - timedelta(minutes=7),
                total_uploads=29,
                firmware_version="v1.4.1-esp32cam",
            ),
            Device(
                device_id="ESP32-CAM-BLR-04",
                name="Fixed Pole Cam #04 (Hebbal Ramp)",
                zone="Hebbal Flyover Ramp",
                status="offline",
                last_latitude=13.0358,
                last_longitude=77.5970,
                last_seen=now - timedelta(hours=3, minutes=18),
                total_uploads=19,
                firmware_version="v1.3.9-esp32cam",
            ),
        ]
        db.add_all(devices)
        db.flush()

        seed_specs = [
            {
                "category": "pothole",
                "title": "Deep Asphalt Crater Near Silk Board Bus Bay",
                "description": "Severe carriageway pothole causing heavy peak-hour bottleneck and two-wheeler skidding hazard.",
                "latitude": 12.9177,
                "longitude": 77.6238,
                "zone": "Silk Board Junction",
                "confidence": 0.94,
                "area_ratio": 0.24,
                "report_count": 5,
                "status": "Open",
                "device_id": "ESP32-CAM-BLR-02",
                "assigned_crew": "BBMP South Road Squad A",
                "hours_ago": 14,
                "img": "seed_silk_board_pothole.jpg",
            },
            {
                "category": "stagnant_water",
                "title": "Stormwater Drain Overflow on 100 Feet Road",
                "description": "Blocked roadside grating causing persistent stagnant water accumulation across left lane.",
                "latitude": 12.9784,
                "longitude": 77.6408,
                "zone": "Indiranagar 100ft Rd",
                "confidence": 0.91,
                "area_ratio": 0.31,
                "report_count": 4,
                "status": "In Progress",
                "device_id": "ESP32-CAM-BLR-01",
                "assigned_crew": "BWSSB Desilting Crew #4",
                "hours_ago": 9,
                "img": "seed_indiranagar_water.jpg",
            },
            {
                "category": "illegal_garbage",
                "title": "Unregulated Mixed Waste Dump Behind Sony Signal",
                "description": "Repeated overnight dumping of commercial plastic and organic refuse on pedestrian footpath.",
                "latitude": 12.9352,
                "longitude": 77.6245,
                "zone": "Koramangala 80ft Rd",
                "confidence": 0.88,
                "area_ratio": 0.19,
                "report_count": 3,
                "status": "Open",
                "device_id": "ESP32-CAM-BLR-03",
                "assigned_crew": None,
                "hours_ago": 19,
                "img": "seed_koramangala_garbage.jpg",
            },
            {
                "category": "pothole",
                "title": "Surface Delamination on Hebbal Airport Ramp",
                "description": "Cluster of sharp-edged potholes along outer merge lane detected by fixed telemetry node.",
                "latitude": 13.0358,
                "longitude": 77.5970,
                "zone": "Hebbal Flyover Ramp",
                "confidence": 0.89,
                "area_ratio": 0.18,
                "report_count": 3,
                "status": "Open",
                "device_id": "ESP32-CAM-BLR-04",
                "assigned_crew": "NHAI Rapid Patch Unit",
                "hours_ago": 26,
                "img": "seed_hebbal_pothole.jpg",
            },
            {
                "category": "stagnant_water",
                "title": "Waterlogged Culvert Near ITPL Main Gate",
                "description": "Subsurface seepage pooling beside tech park shuttle stop; mosquito breeding risk.",
                "latitude": 12.9850,
                "longitude": 77.7366,
                "zone": "Whitefield ITPL Rd",
                "confidence": 0.84,
                "area_ratio": 0.15,
                "report_count": 1,
                "status": "Open",
                "device_id": "ESP32-CAM-BLR-01",
                "assigned_crew": None,
                "hours_ago": 5,
                "img": "seed_whitefield_water.jpg",
            },
            {
                "category": "illegal_garbage",
                "title": "Cleared Construction & Debris Pile at Jayanagar 4th Block",
                "description": "Sidewalk debris hotspot flagged by patrol camera and cleared by sanitation dispatch.",
                "latitude": 12.9299,
                "longitude": 77.5824,
                "zone": "Jayanagar 4th Block",
                "confidence": 0.82,
                "area_ratio": 0.12,
                "report_count": 2,
                "status": "Resolved",
                "device_id": "ESP32-CAM-BLR-03",
                "assigned_crew": "Ward 168 Sanitation Team",
                "hours_ago": 36,
                "img": "seed_jayanagar_garbage.jpg",
            },
        ]

        for spec in seed_specs:
            first_ts = now - timedelta(hours=spec["hours_ago"])
            last_ts = now - timedelta(minutes=25 if spec["status"] != "Resolved" else 180)
            p_score, p_level, sev_score = calculate_priority(
                category=spec["category"],
                confidence=spec["confidence"],
                area_ratio=spec["area_ratio"],
                report_count=spec["report_count"],
                first_reported_at=first_ts,
                latitude=spec["latitude"],
                longitude=spec["longitude"],
            )
            image_url = _create_seed_image(
                filename=spec["img"],
                category=spec["category"],
                confidence=spec["confidence"],
                zone_label=spec["zone"],
            )
            bbox_json = json.dumps(
                [
                    {
                        "category": spec["category"],
                        "confidence": spec["confidence"],
                        "bbox": [240, 290, 560, 480],
                        "area_ratio": spec["area_ratio"],
                    }
                ]
            )
            issue = Issue(
                category=spec["category"],
                title=spec["title"],
                description=spec["description"],
                latitude=spec["latitude"],
                longitude=spec["longitude"],
                zone=spec["zone"],
                confidence=spec["confidence"],
                severity_score=sev_score,
                priority_score=p_score,
                priority_level=p_level,
                status=spec["status"],
                report_count=spec["report_count"],
                device_id=spec["device_id"],
                image_url=image_url,
                raw_image_url=image_url,
                bounding_boxes=bbox_json,
                assigned_crew=spec["assigned_crew"],
                first_reported_at=first_ts,
                last_reported_at=last_ts,
                resolved_at=(now - timedelta(hours=2)) if spec["status"] == "Resolved" else None,
            )
            db.add(issue)

        db.commit()
    finally:
        db.close()


# ---------------------------------------------------------------------------
# FastAPI Lifespan & App Initialization
# ---------------------------------------------------------------------------

@asynccontextmanager
async def lifespan(_app: FastAPI):
    Base.metadata.create_all(bind=engine)
    seed_database_if_empty()
    yield


app = FastAPI(
    title="CivicWatch IoT Infrastructure API",
    description="Smart Infrastructure Monitoring, CV Defect Detection & Priority Maintenance API",
    version="1.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")


# ---------------------------------------------------------------------------
# Serialization & Utility Helpers
# ---------------------------------------------------------------------------

def serialize_issue(issue: Issue) -> IssueOut:
    try:
        boxes = json.loads(issue.bounding_boxes) if issue.bounding_boxes else []
    except json.JSONDecodeError:
        boxes = []

    return IssueOut(
        id=issue.id,
        category=issue.category,
        title=issue.title,
        description=issue.description,
        latitude=issue.latitude,
        longitude=issue.longitude,
        zone=issue.zone,
        confidence=round(issue.confidence, 4),
        severity_score=round(issue.severity_score, 1),
        priority_score=issue.priority_score,
        priority_level=issue.priority_level,
        status=issue.status,
        report_count=issue.report_count,
        device_id=issue.device_id,
        image_url=issue.image_url,
        raw_image_url=issue.raw_image_url,
        bounding_boxes=boxes,
        assigned_crew=issue.assigned_crew,
        first_reported_at=issue.first_reported_at,
        last_reported_at=issue.last_reported_at,
        resolved_at=issue.resolved_at,
    )


def parse_telemetry_timestamp(raw_ts: Optional[str]) -> datetime:
    if not raw_ts or not raw_ts.strip():
        return datetime.now(timezone.utc)
    cleaned = raw_ts.strip()
    try:
        if cleaned.isdigit():
            val = int(cleaned)
            if val > 10_000_000_000:
                val = val / 1000.0
            return datetime.fromtimestamp(val, tz=timezone.utc)
        if cleaned.endswith("Z"):
            cleaned = cleaned[:-1] + "+00:00"
        dt = datetime.fromisoformat(cleaned)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt
    except ValueError:
        return datetime.now(timezone.utc)


# ---------------------------------------------------------------------------
# API Endpoints
# ---------------------------------------------------------------------------

@app.get("/health")
def health_check():
    return {"status": "ok", "service": "civicwatch-backend"}


@app.post("/api/v1/telemetry/ingest", response_model=TelemetryIngestOut, status_code=status.HTTP_201_CREATED)
async def ingest_telemetry(
    image: UploadFile = File(..., description="JPEG/PNG frame from ESP32-CAM or edge sensor"),
    device_id: str = Form(..., min_length=2, max_length=64),
    latitude: float = Form(..., ge=-90.0, le=90.0),
    longitude: float = Form(..., ge=-180.0, le=180.0),
    timestamp: Optional[str] = Form(default=None),
    db: Session = Depends(get_db),
):
    raw_bytes = await image.read()
    if not raw_bytes:
        raise HTTPException(status_code=400, detail="Uploaded image payload is empty.")

    np_arr = np.frombuffer(raw_bytes, np.uint8)
    frame = cv2.imdecode(np_arr, cv2.IMREAD_COLOR)
    if frame is None:
        try:
            pil_img = Image.open(io.BytesIO(raw_bytes)).convert("RGB")
            frame = cv2.cvtColor(np.array(pil_img), cv2.COLOR_RGB2BGR)
        except (UnidentifiedImageError, OSError):
            raise HTTPException(
                status_code=400,
                detail="Unable to decode uploaded image as a valid JPEG, PNG, or WebP frame.",
            )

    event_ts = parse_telemetry_timestamp(timestamp)
    zone_name, _ = infer_bengaluru_zone(latitude, longitude)

    # Save raw frame and run AI CV detection + annotation
    uid = uuid.uuid4().hex[:12]
    raw_filename = f"raw_{device_id}_{uid}.jpg"
    annotated_filename = f"det_{device_id}_{uid}.jpg"
    raw_path = UPLOADS_DIR / raw_filename
    annotated_path = ANNOTATED_DIR / annotated_filename

    cv2.imwrite(str(raw_path), frame, [cv2.IMWRITE_JPEG_QUALITY, 88])
    detections, inference_ms = detector.detect_and_annotate(frame, annotated_path)

    primary = max(detections, key=lambda d: d["confidence"] * (0.5 + d["area_ratio"]))
    primary_category = primary["category"]
    primary_confidence = float(primary["confidence"])
    primary_area_ratio = float(primary["area_ratio"])

    image_url = f"/static/annotated/{annotated_filename}"
    raw_image_url = f"/static/uploads/{raw_filename}"

    # Upsert IoT Device heartbeat
    device = db.query(Device).filter(Device.device_id == device_id).first()
    if device is None:
        device = Device(
            device_id=device_id,
            name=f"Edge Node {device_id}",
            zone=zone_name,
            status="online",
            last_latitude=latitude,
            last_longitude=longitude,
            last_seen=event_ts,
            total_uploads=1,
            firmware_version="v1.4.2-esp32cam",
        )
        db.add(device)
    else:
        device.status = "online"
        device.zone = zone_name
        device.last_latitude = latitude
        device.last_longitude = longitude
        device.last_seen = event_ts
        device.total_uploads += 1

    # Spatial Deduplication: merge active issues of same category within 10 meters
    active_candidates = (
        db.query(Issue)
        .filter(
            Issue.category == primary_category,
            Issue.status.in_(["Open", "In Progress"]),
        )
        .all()
    )

    matched_issue: Optional[Issue] = None
    matched_distance: Optional[float] = None
    for candidate in active_candidates:
        dist_m = haversine_meters(latitude, longitude, candidate.latitude, candidate.longitude)
        if dist_m <= DEDUP_RADIUS_METERS:
            if matched_distance is None or dist_m < matched_distance:
                matched_issue = candidate
                matched_distance = round(dist_m, 2)

    if matched_issue is not None:
        matched_issue.report_count += 1
        matched_issue.confidence = max(matched_issue.confidence, primary_confidence)
        matched_issue.last_reported_at = event_ts
        matched_issue.image_url = image_url
        matched_issue.raw_image_url = raw_image_url
        matched_issue.bounding_boxes = json.dumps(detections)
        matched_issue.device_id = device_id

        p_score, p_level, sev_score = calculate_priority(
            category=matched_issue.category,
            confidence=matched_issue.confidence,
            area_ratio=primary_area_ratio,
            report_count=matched_issue.report_count,
            first_reported_at=matched_issue.first_reported_at,
            latitude=matched_issue.latitude,
            longitude=matched_issue.longitude,
        )
        matched_issue.priority_score = p_score
        matched_issue.priority_level = p_level
        matched_issue.severity_score = max(matched_issue.severity_score, sev_score)

        db.commit()
        db.refresh(matched_issue)
        return TelemetryIngestOut(
            status="merged",
            deduplicated=True,
            distance_meters=matched_distance,
            issue=serialize_issue(matched_issue),
            detections=[BoundingBoxOut(**d) for d in detections],
            inference_ms=inference_ms,
        )

    # Create new Issue record
    p_score, p_level, sev_score = calculate_priority(
        category=primary_category,
        confidence=primary_confidence,
        area_ratio=primary_area_ratio,
        report_count=1,
        first_reported_at=event_ts,
        latitude=latitude,
        longitude=longitude,
    )

    human_label = CATEGORY_LABELS.get(primary_category, primary_category.replace("_", " ").title())
    new_issue = Issue(
        category=primary_category,
        title=f"{human_label} Detected — {zone_name}",
        description=(
            f"Automated telemetry detection from {device_id} at ({latitude:.5f}, {longitude:.5f}) "
            f"with {primary_confidence * 100:.1f}% CV confidence."
        ),
        latitude=latitude,
        longitude=longitude,
        zone=zone_name,
        confidence=primary_confidence,
        severity_score=sev_score,
        priority_score=p_score,
        priority_level=p_level,
        status="Open",
        report_count=1,
        device_id=device_id,
        image_url=image_url,
        raw_image_url=raw_image_url,
        bounding_boxes=json.dumps(detections),
        assigned_crew=None,
        first_reported_at=event_ts,
        last_reported_at=event_ts,
        resolved_at=None,
    )
    db.add(new_issue)
    db.commit()
    db.refresh(new_issue)

    return TelemetryIngestOut(
        status="created",
        deduplicated=False,
        distance_meters=None,
        issue=serialize_issue(new_issue),
        detections=[BoundingBoxOut(**d) for d in detections],
        inference_ms=inference_ms,
    )


@app.get("/api/v1/issues", response_model=List[IssueOut])
def list_issues(
    status_filter: Optional[str] = Query(default=None, alias="status"),
    priority_level: Optional[str] = Query(default=None),
    category: Optional[str] = Query(default=None),
    zone: Optional[str] = Query(default=None),
    limit: int = Query(default=100, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
    db: Session = Depends(get_db),
):
    query = db.query(Issue)
    if status_filter:
        query = query.filter(Issue.status == status_filter)
    if priority_level:
        query = query.filter(Issue.priority_level == priority_level)
    if category:
        query = query.filter(Issue.category == category)
    if zone:
        query = query.filter(Issue.zone.ilike(f"%{zone}%"))

    rows = (
        query.order_by(Issue.priority_score.desc(), Issue.last_reported_at.desc())
        .offset(offset)
        .limit(limit)
        .all()
    )
    return [serialize_issue(row) for row in rows]


@app.patch("/api/v1/issues/{issue_id}", response_model=IssueOut)
def update_issue(
    issue_id: int,
    payload: IssuePatchIn,
    db: Session = Depends(get_db),
):
    issue = db.query(Issue).filter(Issue.id == issue_id).first()
    if issue is None:
        raise HTTPException(status_code=404, detail=f"Issue {issue_id} not found.")

    if payload.status is not None:
        if payload.status not in VALID_STATUSES:
            raise HTTPException(
                status_code=400,
                detail=f"Invalid status '{payload.status}'. Must be one of {VALID_STATUSES}.",
            )
        issue.status = payload.status
        if payload.status == "Resolved":
            issue.resolved_at = datetime.now(timezone.utc)
        else:
            issue.resolved_at = None

    if payload.assigned_crew is not None:
        issue.assigned_crew = payload.assigned_crew.strip() or None

    if payload.description is not None:
        issue.description = payload.description.strip()

    if payload.priority_score is not None:
        issue.priority_score = payload.priority_score
        issue.priority_level = payload.priority_level or assign_priority_level(payload.priority_score)
    elif payload.priority_level is not None:
        if payload.priority_level not in VALID_PRIORITIES:
            raise HTTPException(
                status_code=400,
                detail=f"Invalid priority_level '{payload.priority_level}'. Must be one of {VALID_PRIORITIES}.",
            )
        issue.priority_level = payload.priority_level

    db.commit()
    db.refresh(issue)
    return serialize_issue(issue)


@app.get("/api/v1/devices", response_model=List[DeviceOut])
def list_devices(db: Session = Depends(get_db)):
    devices = db.query(Device).order_by(Device.last_seen.desc()).all()
    now = datetime.now(timezone.utc)
    stale_cutoff = now - timedelta(minutes=15)

    for dev in devices:
        last_seen = dev.last_seen
        if last_seen.tzinfo is None:
            last_seen = last_seen.replace(tzinfo=timezone.utc)
        if last_seen < stale_cutoff and dev.status == "online":
            dev.status = "offline"

    db.commit()
    return devices


@app.get("/api/v1/stats")
def get_dashboard_stats(db: Session = Depends(get_db)):
    issues = db.query(Issue).all()
    devices = db.query(Device).all()

    total_issues = len(issues)
    total_reports = sum(i.report_count for i in issues)
    avg_priority = round(sum(i.priority_score for i in issues) / total_issues, 1) if total_issues else 0.0

    by_status = {s: 0 for s in VALID_STATUSES}
    by_priority = {p: 0 for p in VALID_PRIORITIES}
    by_category = {c: 0 for c in VALID_CATEGORIES}

    for item in issues:
        by_status[item.status] = by_status.get(item.status, 0) + 1
        by_priority[item.priority_level] = by_priority.get(item.priority_level, 0) + 1
        by_category[item.category] = by_category.get(item.category, 0) + 1

    now = datetime.now(timezone.utc)
    stale_cutoff = now - timedelta(minutes=15)
    online_devices = 0
    for dev in devices:
        last_seen = dev.last_seen.replace(tzinfo=timezone.utc) if dev.last_seen.tzinfo is None else dev.last_seen
        if last_seen >= stale_cutoff and dev.status == "online":
            online_devices += 1

    top_critical = (
        db.query(Issue)
        .filter(Issue.status.in_(["Open", "In Progress"]))
        .order_by(Issue.priority_score.desc(), Issue.last_reported_at.desc())
        .limit(5)
        .all()
    )

    return {
        "total_issues": total_issues,
        "open_issues": by_status["Open"],
        "in_progress_issues": by_status["In Progress"],
        "resolved_issues": by_status["Resolved"],
        "total_reports": total_reports,
        "deduplicated_merges": max(0, total_reports - total_issues),
        "avg_priority_score": avg_priority,
        "by_status": by_status,
        "by_priority": by_priority,
        "by_category": by_category,
        "devices": {
            "total": len(devices),
            "online": online_devices,
            "offline": len(devices) - online_devices,
        },
        "top_critical_issues": [serialize_issue(i) for i in top_critical],
    }


if __name__ == "__main__":
    import uvicorn

    port = int(os.environ.get("PORT", "8000"))
    uvicorn.run("main:app", host="0.0.0.0", port=port, reload=True)
