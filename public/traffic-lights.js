export const TRAFFIC_LIGHT_CONSTANTS = {
  GIALLO_URBANO_50KMH: 4,
  TUTTO_ROSSO_INTER_VERDE: 2,
  CICLO_BASSA: 70,
  CICLO_NORMALE: 90,
  CICLO_PUNTA: 120,
  CICLO_ONDA: 80,
  PUNTA_MATTINA_START: '07:30',
  PUNTA_MATTINA_END: '09:30',
  PUNTA_PRANZO_START: '12:30',
  PUNTA_PRANZO_END: '14:30',
  PUNTA_SERA_START: '17:00',
  PUNTA_SERA_END: '19:30',
  LAMPEGGIANTE_START: '23:00',
  LAMPEGGIANTE_END: '07:00',
  ONDA_STEP_SECONDS: 8,
  OFFSET_PRIME: 7919
};

function parseTimeToMinutes(value) {
  const [h, m] = String(value || '00:00').split(':').map((item) => Number(item));
  if (Number.isNaN(h) || Number.isNaN(m)) {
    return 0;
  }
  return h * 60 + m;
}

function getRomeClock(timestampMs) {
  const formatter = new Intl.DateTimeFormat('it-IT', {
    timeZone: 'Europe/Rome',
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });

  const parts = formatter.formatToParts(new Date(timestampMs));
  const values = Object.fromEntries(parts.map((item) => [item.type, item.value]));

  return {
    hour: Number(values.hour || '0'),
    minute: Number(values.minute || '0'),
    second: Number(values.second || '0')
  };
}

function isInRangeMinutes(value, start, end) {
  if (start <= end) {
    return value >= start && value < end;
  }
  return value >= start || value < end;
}

function determineCycleSeconds(minutesOfDay, isOndaVerde) {
  const c = TRAFFIC_LIGHT_CONSTANTS;
  const lampeggianteStart = parseTimeToMinutes(c.LAMPEGGIANTE_START);
  const lampeggianteEnd = parseTimeToMinutes(c.LAMPEGGIANTE_END);

  if (isInRangeMinutes(minutesOfDay, lampeggianteStart, lampeggianteEnd)) {
    return null;
  }

  if (isOndaVerde) {
    return c.CICLO_ONDA;
  }

  const mattinaStart = parseTimeToMinutes(c.PUNTA_MATTINA_START);
  const mattinaEnd = parseTimeToMinutes(c.PUNTA_MATTINA_END);
  const pranzoStart = parseTimeToMinutes(c.PUNTA_PRANZO_START);
  const pranzoEnd = parseTimeToMinutes(c.PUNTA_PRANZO_END);
  const seraStart = parseTimeToMinutes(c.PUNTA_SERA_START);
  const seraEnd = parseTimeToMinutes(c.PUNTA_SERA_END);

  if (
    isInRangeMinutes(minutesOfDay, mattinaStart, mattinaEnd) ||
    isInRangeMinutes(minutesOfDay, pranzoStart, pranzoEnd) ||
    isInRangeMinutes(minutesOfDay, seraStart, seraEnd)
  ) {
    return c.CICLO_PUNTA;
  }

  if (
    isInRangeMinutes(minutesOfDay, parseTimeToMinutes('07:00'), parseTimeToMinutes(c.PUNTA_MATTINA_START)) ||
    isInRangeMinutes(minutesOfDay, parseTimeToMinutes('20:00'), parseTimeToMinutes(c.LAMPEGGIANTE_START))
  ) {
    return c.CICLO_BASSA;
  }

  if (
    isInRangeMinutes(minutesOfDay, parseTimeToMinutes('09:30'), parseTimeToMinutes('12:30')) ||
    isInRangeMinutes(minutesOfDay, parseTimeToMinutes('14:30'), parseTimeToMinutes('17:00'))
  ) {
    return c.CICLO_NORMALE;
  }

  return c.CICLO_BASSA;
}

function computeOffsetSeconds(id, cycle) {
  const digits = String(id || '').replace(/\D/g, '');
  const base = Number.parseInt(digits || '0', 10);
  return (base * TRAFFIC_LIGHT_CONSTANTS.OFFSET_PRIME) % cycle;
}

function resolveCycleContext(semaforo, timestampMs = Date.now()) {
  if (semaforo?.isActive === false) {
    return { disabled: true };
  }

  const rome = getRomeClock(timestampMs);
  const minutesOfDay = rome.hour * 60 + rome.minute;
  const cycle = determineCycleSeconds(minutesOfDay, Boolean(semaforo?.isOndaVerde));

  if (!cycle) {
    return { lampeggiante: true };
  }

  const greenSeconds = Math.max(1, Math.floor(cycle * 0.45));
  const yellowSeconds = TRAFFIC_LIGHT_CONSTANTS.GIALLO_URBANO_50KMH;
  const allRedSeconds = TRAFFIC_LIGHT_CONSTANTS.TUTTO_ROSSO_INTER_VERDE;

  const baseOffset = computeOffsetSeconds(semaforo?.id || '', cycle);
  const ondaOffset = semaforo?.isOndaVerde ? (Number(semaforo?.ondaVerdeOrder) || 0) * TRAFFIC_LIGHT_CONSTANTS.ONDA_STEP_SECONDS : 0;
  const offset = (baseOffset + ondaOffset) % cycle;

  const epochSeconds = Math.floor(timestampMs / 1000);
  const posNelCiclo = (epochSeconds + offset) % cycle;

  return {
    cycle,
    posNelCiclo,
    greenSeconds,
    yellowSeconds,
    allRedSeconds
  };
}

export function calculateTrafficLightState(semaforo, timestampMs = Date.now()) {
  const context = resolveCycleContext(semaforo, timestampMs);

  if (context.disabled) {
    return { stato: 'spento', rimanentiMs: 0 };
  }

  if (context.lampeggiante) {
    return { stato: 'lampeggiante', rimanentiMs: 0 };
  }

  const { cycle, posNelCiclo, greenSeconds, yellowSeconds, allRedSeconds } = context;

  if (posNelCiclo < greenSeconds) {
    return {
      stato: 'verde',
      rimanentiMs: Math.max(0, Math.round((greenSeconds - posNelCiclo) * 1000))
    };
  }

  if (posNelCiclo < greenSeconds + yellowSeconds) {
    return {
      stato: 'giallo',
      rimanentiMs: Math.max(0, Math.round((greenSeconds + yellowSeconds - posNelCiclo) * 1000))
    };
  }

  if (posNelCiclo < greenSeconds + yellowSeconds + allRedSeconds) {
    return {
      stato: 'rosso',
      rimanentiMs: Math.max(0, Math.round((greenSeconds + yellowSeconds + allRedSeconds - posNelCiclo) * 1000))
    };
  }

  return {
    stato: 'rosso',
    rimanentiMs: Math.max(0, Math.round((cycle - posNelCiclo) * 1000))
  };
}

function clampArmTotal(value) {
  const n = Number(value);
  if (Number.isNaN(n)) {
    return 1;
  }
  return Math.max(1, Math.min(8, Math.round(n)));
}

function resolveGroupForArm(armIndex, armTotal) {
  if (armTotal <= 1) {
    return { groupIndex: 0, groupCount: 1 };
  }

  if (armTotal === 2) {
    return {
      groupIndex: armIndex === 1 ? 0 : 1,
      groupCount: 2
    };
  }

  if (armTotal === 3) {
    return {
      groupIndex: Math.max(0, Math.min(2, armIndex - 1)),
      groupCount: 3
    };
  }

  if (armTotal >= 4) {
    const normalizedArm = ((armIndex - 1) % 4) + 1;
    const groupIndex = normalizedArm === 1 || normalizedArm === 3 ? 0 : 1;
    return { groupIndex, groupCount: 2 };
  }

  return { groupIndex: 0, groupCount: 1 };
}

export function calculateTrafficLightArmState(semaforo, armIndex = 1, armTotal = 1, timestampMs = Date.now()) {
  const safeArmTotal = clampArmTotal(armTotal);
  const safeArmIndex = Math.max(1, Math.min(safeArmTotal, Math.round(Number(armIndex) || 1)));

  if (safeArmIndex === 1) {
    return calculateTrafficLightState(semaforo, timestampMs);
  }

  const context = resolveCycleContext(semaforo, timestampMs);
  if (context.disabled) {
    return { stato: 'spento', rimanentiMs: 0 };
  }

  if (context.lampeggiante) {
    return { stato: 'lampeggiante', rimanentiMs: 0 };
  }

  const { cycle, posNelCiclo, yellowSeconds, allRedSeconds } = context;
  const { groupIndex, groupCount } = resolveGroupForArm(safeArmIndex, safeArmTotal);

  if (groupCount <= 1) {
    return calculateTrafficLightState(semaforo, timestampMs);
  }

  const slotLength = cycle / groupCount;
  const dynamicGreen = Math.max(8, Math.floor(slotLength - yellowSeconds - allRedSeconds));
  const blockLength = dynamicGreen + yellowSeconds + allRedSeconds;
  const groupStart = groupIndex * slotLength;

  const localPos = ((posNelCiclo - groupStart) % cycle + cycle) % cycle;

  if (localPos < blockLength) {
    if (localPos < dynamicGreen) {
      return {
        stato: 'verde',
        rimanentiMs: Math.max(0, Math.round((dynamicGreen - localPos) * 1000))
      };
    }

    if (localPos < dynamicGreen + yellowSeconds) {
      return {
        stato: 'giallo',
        rimanentiMs: Math.max(0, Math.round((dynamicGreen + yellowSeconds - localPos) * 1000))
      };
    }
  }

  let timeToNextStart = groupStart - posNelCiclo;
  if (timeToNextStart <= 0) {
    timeToNextStart += cycle;
  }

  return {
    stato: 'rosso',
    rimanentiMs: Math.max(0, Math.round(timeToNextStart * 1000))
  };
}

export function trafficLightStateEmoji(stato) {
  switch (stato) {
    case 'verde':
      return '🟢';
    case 'giallo':
      return '🟡';
    case 'rosso':
      return '🔴';
    case 'lampeggiante':
      return '🟡💡';
    case 'spento':
      return '⚫';
    default:
      return '⚫';
  }
}

export function trafficLightStateBadgeClass(stato) {
  switch (stato) {
    case 'verde':
      return 'badge-verde';
    case 'giallo':
      return 'badge-giallo';
    case 'rosso':
      return 'badge-rosso';
    case 'lampeggiante':
      return 'badge-lampeggiante';
    case 'spento':
      return 'badge-spento';
    default:
      return 'badge-spento';
  }
}
