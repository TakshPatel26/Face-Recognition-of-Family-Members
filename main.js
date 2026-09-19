(() => {
  "use strict";

  const MODEL_URL = "https://justadudewhohacks.github.io/face-api.js/models";
  const STORAGE_KEY = "family-lens-face-profiles-v2";
  const DEFAULT_MEMBERS = ["Father", "Mother", "Brother", "Sister"];
  const MIN_SAMPLES_FOR_MATCH = 8;
  const RECOMMENDED_SAMPLES = 12;
  const MAX_SAMPLES = 20;
  const MIN_FACE_WIDTH_RATIO = 0.18;
  const MIN_SAMPLE_DIFFERENCE = 0.055;
  const MATCH_MARGIN = 0.04;
  const CONFIRMATION_FRAMES = 3;
  const HISTORY_FRAMES = 5;
  const RECOGNITION_INTERVAL_MS = 450;

  const elements = {
    video: document.getElementById("camera"),
    overlay: document.getElementById("overlay"),
    cameraStage: document.getElementById("camera-stage"),
    cameraPlaceholder: document.getElementById("camera-placeholder"),
    captureFlash: document.getElementById("capture-flash"),
    startCamera: document.getElementById("start-camera"),
    stopCamera: document.getElementById("stop-camera"),
    captureSample: document.getElementById("capture-sample"),
    uploadTrigger: document.getElementById("upload-trigger"),
    photoUpload: document.getElementById("photo-upload"),
    recognitionToggle: document.getElementById("recognition-toggle"),
    memberSelect: document.getElementById("member-select"),
    addMemberForm: document.getElementById("add-member-form"),
    newMemberName: document.getElementById("new-member-name"),
    deleteProfile: document.getElementById("delete-profile"),
    profileList: document.getElementById("profile-list"),
    sampleCount: document.getElementById("sample-count"),
    sampleProgress: document.getElementById("sample-progress"),
    totalSamples: document.getElementById("total-samples"),
    poseTipText: document.getElementById("pose-tip-text"),
    threshold: document.getElementById("threshold"),
    thresholdValue: document.getElementById("threshold-value"),
    modelStatusDot: document.getElementById("model-status-dot"),
    modelStatusTitle: document.getElementById("model-status-title"),
    modelStatusDetail: document.getElementById("model-status-detail"),
    liveBadge: document.getElementById("live-badge"),
    resultTitle: document.getElementById("result-title"),
    resultDetail: document.getElementById("result-detail"),
    toast: document.getElementById("toast")
  };

  const state = {
    profiles: new Map(),
    selectedMember: "",
    threshold: 0.48,
    modelsReady: false,
    cameraActive: false,
    processing: false,
    enrollmentBusy: false,
    recognitionTimer: null,
    stream: null,
    toastTimer: null,
    matchHistory: [],
    lastRecognitionErrorAt: 0
  };

  const poseTips = [
    "look straight at the camera in even lighting.",
    "turn your face slightly to the left.",
    "turn your face slightly to the right.",
    "move a little closer and keep both eyes visible.",
    "try a natural smile or a different expression.",
    "try the lighting you normally have in this room."
  ];

  initialise();

  function initialise() {
    loadSavedState();
    bindEvents();
    renderProfiles();
    updateControls();
    loadModels();
  }

  function bindEvents() {
    elements.startCamera.addEventListener("click", startCamera);
    elements.stopCamera.addEventListener("click", stopCamera);
    elements.captureSample.addEventListener("click", captureSample);
    elements.uploadTrigger.addEventListener("click", () => elements.photoUpload.click());
    elements.photoUpload.addEventListener("change", handlePhotoUpload);
    elements.memberSelect.addEventListener("change", () => {
      state.selectedMember = elements.memberSelect.value;
      renderProfiles();
    });
    elements.addMemberForm.addEventListener("submit", addMember);
    elements.deleteProfile.addEventListener("click", deleteSelectedProfile);
    elements.recognitionToggle.addEventListener("change", handleRecognitionToggle);
    elements.threshold.addEventListener("input", handleThresholdChange);
    window.addEventListener("beforeunload", stopCamera);
  }

  async function loadModels() {
    setModelStatus("loading", "Loading face models…", "Downloading detector, landmarks, and recognition model");

    try {
      if (!window.faceapi) {
        throw new Error("The face-api.js library did not load.");
      }

      await Promise.all([
        faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL),
        faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL),
        faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL)
      ]);

      state.modelsReady = true;
      setModelStatus("ready", "Recognition models ready", "Enroll at least 8 varied samples per person");
      updateControls();
      scheduleRecognition(100);
    } catch (error) {
      console.error("Could not load face-recognition models:", error);
      setModelStatus("error", "Models could not be loaded", "Check your internet connection, then reload the page");
      showToast("The recognition models failed to load. Check your connection and reload.", true);
    }
  }

  async function startCamera() {
    if (state.cameraActive) return;

    if (!navigator.mediaDevices?.getUserMedia) {
      showToast("This browser does not support camera access. Use a current browser over HTTPS.", true);
      return;
    }

    const startButtonContent = elements.startCamera.innerHTML;
    elements.startCamera.disabled = true;
    elements.startCamera.textContent = "Starting…";

    try {
      state.stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: "user",
          width: { ideal: 1280 },
          height: { ideal: 720 }
        }
      });

      elements.video.srcObject = state.stream;
      await waitForVideoMetadata();
      await elements.video.play();

      state.cameraActive = true;
      const width = elements.video.videoWidth || 1280;
      const height = elements.video.videoHeight || 720;
      elements.cameraStage.style.aspectRatio = `${width} / ${height}`;
      elements.overlay.width = width;
      elements.overlay.height = height;
      elements.cameraPlaceholder.classList.add("is-hidden");
      elements.liveBadge.classList.add("is-live");
      elements.liveBadge.innerHTML = "<i></i> Live";
      setResult("Looking for a face…", "Keep your face clear and well lit");
      updateControls();
      scheduleRecognition(50);
    } catch (error) {
      console.error("Camera error:", error);
      const message = cameraErrorMessage(error);
      showToast(message, true);
      setResult("Camera unavailable", message);
      stopCamera();
    } finally {
      elements.startCamera.innerHTML = startButtonContent;
      updateControls();
    }
  }

  function stopCamera() {
    window.clearTimeout(state.recognitionTimer);
    state.recognitionTimer = null;

    if (state.stream) {
      state.stream.getTracks().forEach((track) => track.stop());
    }

    state.stream = null;
    state.cameraActive = false;
    state.matchHistory = [];
    elements.video.srcObject = null;
    clearOverlay();
    elements.cameraPlaceholder.classList.remove("is-hidden");
    elements.liveBadge.classList.remove("is-live");
    elements.liveBadge.innerHTML = "<i></i> Camera off";
    setResult("Start the camera to begin", "Known faces will be labelled on the video");
    updateControls();
  }

  function waitForVideoMetadata() {
    if (elements.video.readyState >= 1) return Promise.resolve();

    return new Promise((resolve) => {
      elements.video.addEventListener("loadedmetadata", resolve, { once: true });
    });
  }

  function cameraErrorMessage(error) {
    if (error?.name === "NotAllowedError") {
      return "Camera permission was denied. Allow access in your browser settings and try again.";
    }
    if (error?.name === "NotFoundError") {
      return "No camera was found on this device.";
    }
    if (error?.name === "NotReadableError") {
      return "The camera is being used by another application.";
    }
    return "The camera could not be started. Camera access requires HTTPS or localhost.";
  }

  function scheduleRecognition(delay = RECOGNITION_INTERVAL_MS) {
    window.clearTimeout(state.recognitionTimer);
    if (!state.cameraActive) return;
    state.recognitionTimer = window.setTimeout(recogniseFrame, delay);
  }

  async function recogniseFrame() {
    if (!state.cameraActive) return;

    if (!state.modelsReady || !elements.recognitionToggle.checked || state.processing || state.enrollmentBusy) {
      scheduleRecognition();
      return;
    }

    state.processing = true;

    try {
      const detections = await faceapi
        .detectAllFaces(elements.video, new faceapi.TinyFaceDetectorOptions({
          inputSize: 320,
          scoreThreshold: 0.56
        }))
        .withFaceLandmarks()
        .withFaceDescriptors();

      if (state.cameraActive) {
        drawRecognitionResults(detections);
      }
    } catch (error) {
      console.error("Recognition frame failed:", error);
      const now = Date.now();
      if (now - state.lastRecognitionErrorAt > 10000) {
        showToast("A recognition frame failed; the app will keep trying.", true);
        state.lastRecognitionErrorAt = now;
      }
    } finally {
      state.processing = false;
      scheduleRecognition();
    }
  }

  function drawRecognitionResults(detections) {
    clearOverlay();

    if (detections.length === 0) {
      rememberMatchFrame([]);
      setResult("No face detected", "Face the camera and use even, front-facing light");
      return;
    }

    const readyProfileCount = getReadyProfiles().length;
    const rawMatches = detections.map((detection) => matchDescriptor(detection.descriptor));
    const matches = applyTemporalConfirmation(rawMatches);

    detections.forEach((detection, index) => {
      const match = matches[index];
      const sourceBox = detection.detection.box;
      const mirroredBox = {
        x: elements.overlay.width - sourceBox.x - sourceBox.width,
        y: sourceBox.y,
        width: sourceBox.width,
        height: sourceBox.height
      };
      const distanceText = Number.isFinite(match.distance) ? ` · ${match.distance.toFixed(2)}` : "";
      const displayName = match.label === "Unknown"
        ? "Unknown"
        : match.confirmed ? match.label : `Checking ${match.label}`;
      const label = `${displayName}${distanceText}`;
      const boxColor = match.label === "Unknown"
        ? "#ef6b5d"
        : match.confirmed ? "#c9ed70" : "#f6c85f";

      new faceapi.draw.DrawBox(mirroredBox, {
        label,
        boxColor,
        lineWidth: 3,
        drawLabelOptions: {
          fontColor: match.label === "Unknown" ? "#ffffff" : "#17231f",
          backgroundColor: boxColor,
          fontSize: 15,
          padding: 6
        }
      }).draw(elements.overlay);
    });

    if (readyProfileCount === 0) {
      setResult(
        `${detections.length} ${pluralise(detections.length, "face")} detected — no ready profiles`,
        `Enroll at least ${MIN_SAMPLES_FOR_MATCH} samples for one person to start matching`
      );
      return;
    }

    const knownMatches = matches.filter((match) => match.confirmed);
    const verifyingMatches = matches.filter((match) => match.label !== "Unknown" && !match.confirmed);
    const unknownCount = matches.filter((match) => match.label === "Unknown").length;

    if (knownMatches.length === 0 && verifyingMatches.length > 0) {
      const names = [...new Set(verifyingMatches.map((match) => match.label))];
      setResult(
        `Verifying ${names.join(", ")}…`,
        `Hold still for ${CONFIRMATION_FRAMES} consistent frames`
      );
      return;
    }

    if (knownMatches.length === 0) {
      setResult(
        `${detections.length} unknown ${pluralise(detections.length, "face")}`,
        "No match passed the distance and ambiguity checks"
      );
      return;
    }

    const uniqueNames = [...new Set(knownMatches.map((match) => match.label))];
    const bestDistance = Math.min(...knownMatches.map((match) => match.distance));
    const extra = unknownCount > 0 ? ` · ${unknownCount} unknown` : "";
    setResult(
      `${uniqueNames.join(", ")} recognized`,
      `Confirmed across frames · distance ${bestDistance.toFixed(3)} (lower is better)${extra}`
    );
  }

  function applyTemporalConfirmation(matches) {
    const labels = [...new Set(
      matches
        .filter((match) => match.label !== "Unknown")
        .map((match) => match.label)
    )];
    rememberMatchFrame(labels);

    return matches.map((match) => {
      if (match.label === "Unknown") return { ...match, confirmed: false };

      let consecutiveFrames = 0;
      for (let index = state.matchHistory.length - 1; index >= 0; index -= 1) {
        if (!state.matchHistory[index].includes(match.label)) break;
        consecutiveFrames += 1;
      }

      return { ...match, confirmed: consecutiveFrames >= CONFIRMATION_FRAMES };
    });
  }

  function rememberMatchFrame(labels) {
    state.matchHistory.push(labels);
    if (state.matchHistory.length > HISTORY_FRAMES) {
      state.matchHistory.shift();
    }
  }

  function matchDescriptor(descriptor) {
    const candidates = getReadyProfiles().map(([name, samples]) => {
      const distances = samples
        .map((sample) => faceapi.euclideanDistance(descriptor, sample))
        .sort((a, b) => a - b);
      const neighbourCount = Math.min(3, distances.length);
      const distance = distances
        .slice(0, neighbourCount)
        .reduce((sum, value) => sum + value, 0) / neighbourCount;
      return { name, distance };
    }).sort((a, b) => a.distance - b.distance);

    if (candidates.length === 0) {
      return { label: "Unknown", distance: null, reason: "no-profiles" };
    }

    const best = candidates[0];
    const second = candidates[1];
    const isCloseEnough = best.distance <= state.threshold;
    const isUnambiguous = !second || second.distance - best.distance >= MATCH_MARGIN;

    if (isCloseEnough && isUnambiguous) {
      return { label: best.name, distance: best.distance, reason: "matched" };
    }

    return {
      label: "Unknown",
      distance: best.distance,
      reason: isCloseEnough ? "ambiguous" : "too-far"
    };
  }

  function getReadyProfiles() {
    return [...state.profiles.entries()].filter(([, samples]) => samples.length >= MIN_SAMPLES_FOR_MATCH);
  }

  async function captureSample() {
    if (!state.modelsReady || !state.cameraActive || state.enrollmentBusy) return;

    const name = state.selectedMember;
    const samples = state.profiles.get(name);
    if (!samples) return;

    if (samples.length >= MAX_SAMPLES) {
      showToast(`${name} already has the maximum of ${MAX_SAMPLES} samples.`);
      return;
    }

    state.enrollmentBusy = true;
    updateControls();

    try {
      await waitForRecognitionTask();
      state.processing = true;

      const detections = await faceapi
        .detectAllFaces(elements.video, enrollmentDetectorOptions())
        .withFaceLandmarks()
        .withFaceDescriptors();

      const validation = validateEnrollmentDetection(detections, elements.video.videoWidth);
      if (!validation.ok) {
        showToast(validation.message, true);
        return;
      }

      const descriptor = validation.detection.descriptor;
      if (isNearDuplicate(samples, descriptor)) {
        showToast("That view is too similar to one already saved. Change angle, expression, or lighting.");
        return;
      }

      samples.push(Array.from(descriptor));
      saveState();
      renderProfiles();
      flashCamera();
      showToast(`Sample ${samples.length} saved for ${name}.`);
    } catch (error) {
      console.error("Could not capture sample:", error);
      showToast("The face sample could not be captured. Please try again.", true);
    } finally {
      state.processing = false;
      state.enrollmentBusy = false;
      updateControls();
    }
  }

  async function handlePhotoUpload(event) {
    const files = [...event.target.files];
    event.target.value = "";
    if (!files.length || !state.modelsReady || state.enrollmentBusy) return;

    const name = state.selectedMember;
    const samples = state.profiles.get(name);
    if (!samples) return;

    if (samples.length >= MAX_SAMPLES) {
      showToast(`${name} already has the maximum of ${MAX_SAMPLES} samples.`);
      return;
    }

    state.enrollmentBusy = true;
    updateControls();
    let added = 0;
    let skipped = 0;

    try {
      await waitForRecognitionTask();
      state.processing = true;

      for (const file of files) {
        if (samples.length >= MAX_SAMPLES) {
          skipped += 1;
          continue;
        }

        try {
          const image = await faceapi.bufferToImage(file);
          const detections = await faceapi
            .detectAllFaces(image, enrollmentDetectorOptions())
            .withFaceLandmarks()
            .withFaceDescriptors();
          const validation = validateEnrollmentDetection(detections, image.naturalWidth || image.width, 0.12);

          if (!validation.ok || isNearDuplicate(samples, validation.detection.descriptor)) {
            skipped += 1;
            continue;
          }

          samples.push(Array.from(validation.detection.descriptor));
          added += 1;
        } catch (error) {
          console.warn(`Skipped ${file.name}:`, error);
          skipped += 1;
        }
      }

      if (added > 0) {
        saveState();
        renderProfiles();
      }

      const skippedMessage = skipped ? ` ${skipped} skipped (use one clear, varied face per photo).` : "";
      showToast(`${added} ${pluralise(added, "sample")} added for ${name}.${skippedMessage}`, added === 0);
    } catch (error) {
      console.error("Could not process uploaded photos:", error);
      showToast("The selected photos could not be processed. Try clear JPEG, PNG, or WebP portraits.", true);
    } finally {
      state.processing = false;
      state.enrollmentBusy = false;
      updateControls();
    }
  }

  function enrollmentDetectorOptions() {
    return new faceapi.TinyFaceDetectorOptions({
      inputSize: 416,
      scoreThreshold: 0.67
    });
  }

  function validateEnrollmentDetection(detections, imageWidth, minimumWidthRatio = MIN_FACE_WIDTH_RATIO) {
    if (detections.length === 0) {
      return { ok: false, message: "No clear face found. Move closer and use brighter, even light." };
    }

    if (detections.length > 1) {
      return { ok: false, message: "More than one face was found. Enrollment photos must contain one person only." };
    }

    const detection = detections[0];
    if (detection.detection.box.width / imageWidth < minimumWidthRatio) {
      return { ok: false, message: "The face is too small. Move closer or use a tighter portrait." };
    }

    return { ok: true, detection };
  }

  function isNearDuplicate(samples, descriptor) {
    if (samples.length === 0) return false;
    const nearestDistance = Math.min(
      ...samples.map((sample) => faceapi.euclideanDistance(descriptor, sample))
    );
    return nearestDistance < MIN_SAMPLE_DIFFERENCE;
  }

  async function waitForRecognitionTask() {
    const start = Date.now();
    while (state.processing && Date.now() - start < 3000) {
      await new Promise((resolve) => window.setTimeout(resolve, 40));
    }
  }

  function addMember(event) {
    event.preventDefault();
    const name = elements.newMemberName.value.trim().replace(/\s+/g, " ");

    if (!name) {
      showToast("Enter a name for the new family member.", true);
      return;
    }

    const existingName = [...state.profiles.keys()].find(
      (profileName) => profileName.toLocaleLowerCase() === name.toLocaleLowerCase()
    );

    if (existingName) {
      state.selectedMember = existingName;
      elements.newMemberName.value = "";
      renderProfiles();
      showToast(`${existingName} already has a profile.`);
      return;
    }

    state.profiles.set(name, []);
    state.selectedMember = name;
    elements.newMemberName.value = "";
    saveState();
    renderProfiles();
    showToast(`${name} added. Capture at least ${MIN_SAMPLES_FOR_MATCH} varied samples.`);
  }

  function deleteSelectedProfile() {
    if (state.profiles.size <= 1) {
      showToast("Keep at least one profile. Add another person before deleting this one.", true);
      return;
    }

    const name = state.selectedMember;
    const sampleCount = state.profiles.get(name)?.length || 0;
    const confirmation = window.confirm(
      `Delete ${name} and ${sampleCount} saved ${pluralise(sampleCount, "sample")}? This cannot be undone.`
    );
    if (!confirmation) return;

    state.profiles.delete(name);
    state.selectedMember = state.profiles.keys().next().value;
    saveState();
    renderProfiles();
    showToast(`${name} was deleted.`);
  }

  function handleRecognitionToggle() {
    state.matchHistory = [];
    if (!elements.recognitionToggle.checked) {
      clearOverlay();
      setResult("Live recognition paused", "Enrollment capture is still available");
    } else if (state.cameraActive) {
      setResult("Looking for a face…", "Keep your face clear and well lit");
      scheduleRecognition(20);
    }
  }

  function handleThresholdChange() {
    state.threshold = Number(elements.threshold.value);
    state.matchHistory = [];
    elements.thresholdValue.value = state.threshold.toFixed(2);
    saveState();
  }

  function loadSavedState() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
      if (saved?.version === 2 && Array.isArray(saved.profiles)) {
        saved.profiles.forEach((profile) => {
          if (typeof profile?.name !== "string" || !profile.name.trim() || !Array.isArray(profile.descriptors)) {
            return;
          }

          const descriptors = profile.descriptors
            .filter(isValidDescriptor)
            .slice(0, MAX_SAMPLES)
            .map((descriptor) => descriptor.map(Number));
          state.profiles.set(profile.name.trim().slice(0, 30), descriptors);
        });
      }

      if (Number.isFinite(saved?.threshold)) {
        state.threshold = Math.min(0.58, Math.max(0.42, saved.threshold));
      }
    } catch (error) {
      console.warn("Saved profiles could not be read:", error);
    }

    if (state.profiles.size === 0) {
      DEFAULT_MEMBERS.forEach((name) => state.profiles.set(name, []));
    }

    state.selectedMember = state.profiles.keys().next().value;
    elements.threshold.value = state.threshold.toFixed(2);
    elements.thresholdValue.value = state.threshold.toFixed(2);
  }

  function isValidDescriptor(descriptor) {
    return Array.isArray(descriptor)
      && descriptor.length === 128
      && descriptor.every((value) => Number.isFinite(Number(value)));
  }

  function saveState() {
    const data = {
      version: 2,
      threshold: state.threshold,
      profiles: [...state.profiles.entries()].map(([name, descriptors]) => ({ name, descriptors }))
    };

    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch (error) {
      console.error("Could not save profiles:", error);
      showToast("Face profiles could not be saved. Browser storage may be full or disabled.", true);
    }
  }

  function renderProfiles() {
    const currentSelection = state.profiles.has(state.selectedMember)
      ? state.selectedMember
      : state.profiles.keys().next().value;
    state.selectedMember = currentSelection;

    elements.memberSelect.replaceChildren();
    elements.profileList.replaceChildren();

    let total = 0;
    state.profiles.forEach((samples, name) => {
      total += samples.length;

      const option = document.createElement("option");
      option.value = name;
      option.textContent = name;
      option.selected = name === currentSelection;
      elements.memberSelect.append(option);

      const card = document.createElement("button");
      card.type = "button";
      card.className = `profile-card${name === currentSelection ? " is-selected" : ""}`;
      card.addEventListener("click", () => {
        state.selectedMember = name;
        renderProfiles();
      });

      const avatar = document.createElement("span");
      avatar.className = "profile-avatar";
      avatar.textContent = initials(name);

      const info = document.createElement("span");
      info.className = "profile-info";
      const profileName = document.createElement("strong");
      profileName.textContent = name;
      const count = document.createElement("small");
      count.textContent = `${samples.length} ${pluralise(samples.length, "sample")} saved`;
      info.append(profileName, count);

      const profileState = document.createElement("span");
      profileState.className = "profile-state";
      if (samples.length >= RECOMMENDED_SAMPLES) {
        profileState.classList.add("is-ready");
        profileState.textContent = "Strong";
      } else if (samples.length >= MIN_SAMPLES_FOR_MATCH) {
        profileState.classList.add("is-ready");
        profileState.textContent = "Ready";
      } else {
        profileState.textContent = `${MIN_SAMPLES_FOR_MATCH - samples.length} needed`;
      }

      card.append(avatar, info, profileState);
      elements.profileList.append(card);
    });

    elements.memberSelect.value = currentSelection;
    elements.totalSamples.textContent = `${total} ${pluralise(total, "sample")}`;
    renderSelectedMemberProgress();
    updateControls();
  }

  function renderSelectedMemberProgress() {
    const count = state.profiles.get(state.selectedMember)?.length || 0;
    elements.sampleCount.textContent = `${count} / ${RECOMMENDED_SAMPLES} recommended`;
    elements.sampleProgress.style.width = `${Math.min(100, (count / RECOMMENDED_SAMPLES) * 100)}%`;

    const tip = poseTips[count % poseTips.length];
    elements.poseTipText.replaceChildren();
    const strong = document.createElement("strong");
    strong.textContent = count >= RECOMMENDED_SAMPLES ? "Profile is strong: " : "For the next sample: ";
    elements.poseTipText.append(strong, document.createTextNode(tip));
  }

  function updateControls() {
    elements.startCamera.disabled = state.cameraActive;
    elements.stopCamera.disabled = !state.cameraActive;
    elements.captureSample.disabled = !state.cameraActive || !state.modelsReady || state.enrollmentBusy;
    elements.uploadTrigger.disabled = !state.modelsReady || state.enrollmentBusy;
  }

  function setModelStatus(type, title, detail) {
    elements.modelStatusDot.className = `status-dot is-${type}`;
    elements.modelStatusTitle.textContent = title;
    elements.modelStatusDetail.textContent = detail;
  }

  function setResult(title, detail) {
    elements.resultTitle.textContent = title;
    elements.resultDetail.textContent = detail;
  }

  function clearOverlay() {
    const context = elements.overlay.getContext("2d");
    context.clearRect(0, 0, elements.overlay.width, elements.overlay.height);
  }

  function flashCamera() {
    elements.captureFlash.classList.remove("is-active");
    void elements.captureFlash.offsetWidth;
    elements.captureFlash.classList.add("is-active");
  }

  function showToast(message, isError = false) {
    window.clearTimeout(state.toastTimer);
    elements.toast.textContent = message;
    elements.toast.classList.toggle("is-error", isError);
    elements.toast.classList.add("is-visible");
    state.toastTimer = window.setTimeout(() => {
      elements.toast.classList.remove("is-visible");
    }, 4200);
  }

  function initials(name) {
    return name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0].toLocaleUpperCase())
      .join("");
  }

  function pluralise(count, singular) {
    return count === 1 ? singular : `${singular}s`;
  }
})();
