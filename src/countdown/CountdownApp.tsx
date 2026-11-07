import React, { useEffect, useState, useRef, useCallback, memo } from 'react';
import './countdown.css';

interface CountdownAppProps {
  onUnlock?: () => void;
}

interface ReleaseStatus {
  locked: boolean;
  serverNow: string;
  unlockAt: string;
}

interface LaunchConfig {
  tunnelUrl?: string;
  releaseTime?: string;
  updatedAt?: string;
}

const DEFAULT_RELEASE_TIME_ISO = '2026-11-20T18:30:00Z';
const CLOUDFLARE_TUNNEL_REGEX = /^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/;

// Rolling Single Digit Component with smooth vertical roll
const RollingDigit = memo(({ value }: { value: string }) => {
  const [displayValue, setDisplayValue] = useState(value);
  const [prevValue, setPrevValue] = useState<string | null>(null);
  const [animating, setAnimating] = useState(false);

  useEffect(() => {
    if (value !== displayValue) {
      setPrevValue(displayValue);
      setDisplayValue(value);
      setAnimating(true);
      const timer = setTimeout(() => {
        setAnimating(false);
        setPrevValue(null);
      }, 350);
      return () => clearTimeout(timer);
    }
  }, [value, displayValue]);

  return (
    <div className="relative inline-block overflow-hidden h-[1.15em] w-[0.62em] text-center select-none">
      {animating && prevValue !== null && (
        <span className="absolute inset-0 flex items-center justify-center roll-digit-exit">
          {prevValue}
        </span>
      )}
      <span
        className={`absolute inset-0 flex items-center justify-center ${
          animating ? 'roll-digit-enter' : ''
        }`}
      >
        {displayValue}
      </span>
    </div>
  );
});
RollingDigit.displayName = 'RollingDigit';

// Two-digit Roll Unit (supports any digit length, min 2 digits)
const RollValue = memo(({ value }: { value: number }) => {
  const str = String(Math.max(0, value)).padStart(2, '0');
  return (
    <div className="flex items-center justify-center font-mono tracking-tight">
      {str.split('').map((char, index) => (
        <RollingDigit key={index} value={char} />
      ))}
    </div>
  );
});
RollValue.displayName = 'RollValue';

export interface TimeRemaining {
  days: number;
  hours: number;
  minutes: number;
  seconds: number;
  totalMs: number;
  isUnlocked: boolean;
}

/**
 * Pure calculation function for remaining time using UTC epoch milliseconds.
 * - Entirely timezone-independent and DST-immune (pure UTC ms subtraction).
 * - When server sync fails or tunnelUrl is empty, serverOffsetMs is 0.
 * - Never retains leftover or stale offset from earlier sessions.
 */
export function computeRemainingTime(
  targetMs: number,
  clientNowMs: number,
  serverOffsetMs: number = 0
): TimeRemaining {
  const currentEffectiveTime = clientNowMs + serverOffsetMs;
  const totalMs = Math.max(0, targetMs - currentEffectiveTime);
  const isUnlocked = totalMs <= 0;

  const days = Math.floor(totalMs / (1000 * 60 * 60 * 24));
  const hours = Math.floor((totalMs % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
  const minutes = Math.floor((totalMs % (1000 * 60 * 60)) / (1000 * 60));
  const seconds = Math.floor((totalMs % (1000 * 60)) / 1000);

  return { days, hours, minutes, seconds, totalMs, isUnlocked };
}

export const CountdownApp: React.FC<CountdownAppProps> = ({ onUnlock }) => {
  const [timeLeft, setTimeLeft] = useState<{
    days: number;
    hours: number;
    minutes: number;
    seconds: number;
  }>({ days: 0, hours: 0, minutes: 0, seconds: 0 });

  const [isVerifying, setIsVerifying] = useState<boolean>(false);
  const [syncError, setSyncError] = useState<boolean>(false);

  const serverOffsetRef = useRef<number>(0);
  const unlockTargetMsRef = useRef<number>(new Date(DEFAULT_RELEASE_TIME_ISO).getTime());
  const tunnelUrlRef = useRef<string>('');
  const timerRef = useRef<number | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const isFetchingRef = useRef<boolean>(false);
  const backoffAttemptRef = useRef<number>(0);
  const nextPollTimeoutRef = useRef<number | null>(null);

  // Authoritative server clock & tunnel config sync with bounded backoff
  const fetchServerStatus = useCallback(async () => {
    if (isFetchingRef.current) return;
    isFetchingRef.current = true;

    try {
      // 1. Fetch public launch configuration with cache-busting
      let targetTunnel = '';
      try {
        const cfgRes = await fetch('./launch-config.json?_t=' + Date.now(), {
          cache: 'no-store',
        });
        if (cfgRes.ok) {
          const cfg: LaunchConfig = await cfgRes.json();
          if (cfg.tunnelUrl && typeof cfg.tunnelUrl === 'string') {
            const cleanUrl = cfg.tunnelUrl.trim().replace(/\/+$/, '');
            if (CLOUDFLARE_TUNNEL_REGEX.test(cleanUrl)) {
              targetTunnel = cleanUrl;
              tunnelUrlRef.current = targetTunnel;
            } else {
              tunnelUrlRef.current = '';
            }
          } else {
            tunnelUrlRef.current = '';
          }
          if (cfg.releaseTime) {
            const parsedTarget = new Date(cfg.releaseTime).getTime();
            if (!isNaN(parsedTarget)) {
              unlockTargetMsRef.current = parsedTarget;
            }
          }
        }
      } catch {
        tunnelUrlRef.current = '';
      }

      // If tunnelUrl is empty, we are in standalone public countdown mode on GitHub Pages.
      // Must NOT attempt /api/release/status (which 404s).
      // Fallback cleanly to local client UTC clock with zero leftover offset!
      if (!targetTunnel) {
        serverOffsetRef.current = 0;
        setSyncError(false);
        setIsVerifying(false);
        return;
      }

      // 2. Fetch authoritative release status from tunnel origin
      setIsVerifying(true);
      const res = await fetch(`${targetTunnel}/api/release/status`, {
        headers: { 'Cache-Control': 'no-cache' },
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const data: ReleaseStatus = await res.json();

      const serverTimeMs = new Date(data.serverNow).getTime();
      const unlockMs = new Date(data.unlockAt).getTime();

      if (!isNaN(serverTimeMs) && !isNaN(unlockMs)) {
        // Authoritative server offset relative to UTC epoch ms
        serverOffsetRef.current = serverTimeMs - Date.now();
        unlockTargetMsRef.current = unlockMs;
        setSyncError(false);
      }

      // Transition strictly when server confirms locked: false AND origin is verified
      if (!data.locked) {
        setIsVerifying(false);
        if (targetTunnel && CLOUDFLARE_TUNNEL_REGEX.test(targetTunnel)) {
          // Fresh verification request right before redirect
          const confirmRes = await fetch(`${targetTunnel}/api/release/status`, {
            headers: { 'Cache-Control': 'no-cache' },
          });
          if (confirmRes.ok) {
            const confirmData: ReleaseStatus = await confirmRes.json();
            if (!confirmData.locked) {
              const hash = window.location.hash || '';
              const cleanTunnel = targetTunnel.replace(/\/$/, '');
              window.location.href = cleanTunnel + '/' + hash;
              return;
            }
          }
        } else if (onUnlock) {
          onUnlock();
          return;
        }
      } else {
        // If server is still locked, reset verifying indicator
        setIsVerifying(false);

        // If client time has reached or passed zero, schedule next poll with bounded backoff (1.5s - 5s)
        const effectiveNow = Date.now() + serverOffsetRef.current;
        if (effectiveNow >= unlockTargetMsRef.current) {
          const delayMs = Math.min(5000, 1500 * Math.pow(1.4, backoffAttemptRef.current));
          backoffAttemptRef.current += 1;
          if (nextPollTimeoutRef.current) clearTimeout(nextPollTimeoutRef.current);
          nextPollTimeoutRef.current = window.setTimeout(() => {
            fetchServerStatus();
          }, delayMs);
        } else {
          backoffAttemptRef.current = 0;
        }
      }
    } catch {
      // On failure: fall back cleanly to local client clock with NO leftover offset
      serverOffsetRef.current = 0;
      setSyncError(true);
      setIsVerifying(false);

      // In case of error at or near zero, retry with bounded backoff
      const effectiveNow = Date.now() + serverOffsetRef.current;
      if (effectiveNow >= unlockTargetMsRef.current) {
        const delayMs = Math.min(5000, 2000 * Math.pow(1.3, backoffAttemptRef.current));
        backoffAttemptRef.current += 1;
        if (nextPollTimeoutRef.current) clearTimeout(nextPollTimeoutRef.current);
        nextPollTimeoutRef.current = window.setTimeout(() => {
          fetchServerStatus();
        }, delayMs);
      }
    } finally {
      isFetchingRef.current = false;
    }
  }, [onUnlock]);

  // Dynamic poll scheduling: 30s standard, 5s during final minute before release
  useEffect(() => {
    fetchServerStatus();

    const intervalTimer = setInterval(() => {
      const remainingMs = Math.max(0, unlockTargetMsRef.current - (Date.now() + serverOffsetRef.current));
      // In the final 60s, poll every 5s; otherwise every 30s
      if (remainingMs <= 60000 && remainingMs > 0) {
        fetchServerStatus();
      }
    }, 5000);

    const normalInterval = setInterval(() => {
      fetchServerStatus();
    }, 30000);

    return () => {
      clearInterval(intervalTimer);
      clearInterval(normalInterval);
      if (nextPollTimeoutRef.current) clearTimeout(nextPollTimeoutRef.current);
    };
  }, [fetchServerStatus]);

  // High-precision ticker (Date.now() + server offset in UTC ms)
  useEffect(() => {
    const updateCountdown = () => {
      if (!unlockTargetMsRef.current) return;

      const remaining = computeRemainingTime(
        unlockTargetMsRef.current,
        Date.now(),
        serverOffsetRef.current
      );

      setTimeLeft({
        days: remaining.days,
        hours: remaining.hours,
        minutes: remaining.minutes,
        seconds: remaining.seconds,
      });

      if (remaining.isUnlocked && tunnelUrlRef.current && !isFetchingRef.current) {
        fetchServerStatus();
      }
    };

    updateCountdown();
    timerRef.current = window.setInterval(updateCountdown, 250);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [fetchServerStatus]);

  // 60fps Lightweight Canvas Ambient Background (Orbs, micro-stars, floating petals)
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d', { alpha: true });
    if (!ctx) return;

    let animId: number;
    let isVisible = !document.hidden;
    const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    let width = 0;
    let height = 0;

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      width = window.innerWidth;
      height = window.innerHeight;
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      ctx.scale(dpr, dpr);
    };

    resize();
    window.addEventListener('resize', resize);

    // Micro twinkling stars
    const stars = Array.from({ length: 36 }, () => ({
      x: Math.random() * width,
      y: Math.random() * height,
      r: Math.random() * 1.5 + 0.5,
      alpha: Math.random() * 0.7 + 0.2,
      speed: Math.random() * 0.02 + 0.008,
      phase: Math.random() * Math.PI * 2,
    }));

    // Floating soft bokeh orbs
    const orbs = [
      { x: width * 0.2, y: height * 0.3, r: 140, color: 'rgba(236, 72, 153, 0.06)', vx: 0.08, vy: -0.05 },
      { x: width * 0.8, y: height * 0.4, r: 180, color: 'rgba(168, 85, 247, 0.07)', vx: -0.06, vy: 0.07 },
      { x: width * 0.5, y: height * 0.7, r: 210, color: 'rgba(251, 146, 60, 0.05)', vx: 0.05, vy: -0.06 },
      { x: width * 0.3, y: height * 0.8, r: 160, color: 'rgba(244, 63, 94, 0.06)', vx: -0.07, vy: -0.04 },
    ];

    // Gentle upward drifting petals with parallax
    const petals = Array.from({ length: 18 }, () => ({
      x: Math.random() * width,
      y: Math.random() * height,
      size: Math.random() * 5 + 3,
      vy: -(Math.random() * 0.45 + 0.25),
      swaySpeed: Math.random() * 0.015 + 0.008,
      swayAmp: Math.random() * 25 + 10,
      phase: Math.random() * Math.PI * 2,
      rotation: Math.random() * Math.PI * 2,
      rotSpeed: (Math.random() - 0.5) * 0.015,
      alpha: Math.random() * 0.45 + 0.15,
    }));

    let lastTime = performance.now();

    const render = (time: number) => {
      if (!isVisible) {
        animId = requestAnimationFrame(render);
        return;
      }

      const dt = Math.min(32, time - lastTime);
      lastTime = time;

      ctx.clearRect(0, 0, width, height);

      // 1. Draw Bokeh Orbs
      for (const orb of orbs) {
        if (!prefersReducedMotion) {
          orb.x += orb.vx * (dt / 16);
          orb.y += orb.vy * (dt / 16);
          if (orb.x < -orb.r) orb.x = width + orb.r;
          if (orb.x > width + orb.r) orb.x = -orb.r;
          if (orb.y < -orb.r) orb.y = height + orb.r;
          if (orb.y > height + orb.r) orb.y = -orb.r;
        }

        const grad = ctx.createRadialGradient(orb.x, orb.y, 0, orb.x, orb.y, orb.r);
        grad.addColorStop(0, orb.color);
        grad.addColorStop(1, 'transparent');
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(orb.x, orb.y, orb.r, 0, Math.PI * 2);
        ctx.fill();
      }

      // 2. Draw Twinkling Stars
      for (const star of stars) {
        if (!prefersReducedMotion) {
          star.phase += star.speed;
        }
        const a = star.alpha * (0.6 + 0.4 * Math.sin(star.phase));
        ctx.fillStyle = `rgba(255, 235, 205, ${a})`;
        ctx.beginPath();
        ctx.arc(star.x, star.y, star.r, 0, Math.PI * 2);
        ctx.fill();
      }

      // 3. Draw Upward Floating Petals
      for (const petal of petals) {
        if (!prefersReducedMotion) {
          petal.y += petal.vy * (dt / 16);
          petal.phase += petal.swaySpeed;
          petal.rotation += petal.rotSpeed;

          if (petal.y < -20) {
            petal.y = height + 20;
            petal.x = Math.random() * width;
          }
        }

        const currentX = petal.x + Math.sin(petal.phase) * petal.swayAmp;

        ctx.save();
        ctx.translate(currentX, petal.y);
        ctx.rotate(petal.rotation);
        ctx.fillStyle = `rgba(255, 182, 193, ${petal.alpha})`;

        // Organic petal leaf path
        ctx.beginPath();
        ctx.moveTo(0, -petal.size);
        ctx.quadraticCurveTo(petal.size * 0.8, 0, 0, petal.size);
        ctx.quadraticCurveTo(-petal.size * 0.8, 0, 0, -petal.size);
        ctx.fill();
        ctx.restore();
      }

      if (!prefersReducedMotion) {
        animId = requestAnimationFrame(render);
      }
    };

    const handleVisibility = () => {
      isVisible = !document.hidden;
      if (isVisible) lastTime = performance.now();
    };

    document.addEventListener('visibilitychange', handleVisibility);
    animId = requestAnimationFrame(render);

    return () => {
      cancelAnimationFrame(animId);
      window.removeEventListener('resize', resize);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, []);

  // Calculate circular arc progress for seconds (0 -> 60)
  const secProgress = timeLeft.seconds / 60;
  const radius = 46;
  const circumference = 2 * Math.PI * radius;
  const strokeDashoffset = circumference * (1 - secProgress);

  return (
    <div className="relative w-full min-h-screen bg-[#0C0614] flex flex-col items-center justify-center select-none text-white overflow-hidden p-4 sm:p-6 md:p-8">
      {/* 60fps Ambient Background Canvas */}
      <canvas ref={canvasRef} className="absolute inset-0 pointer-events-none z-0" />

      {/* Atmospheric Aurora Radial Glow behind the timer */}
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[22rem] sm:w-[36rem] md:w-[48rem] h-[22rem] sm:h-[36rem] md:h-[48rem] countdown-radial-glow rounded-full pointer-events-none z-0" />

      {/* Main Centered Unit */}
      <main className="relative z-10 flex flex-col items-center justify-center w-full max-w-5xl mx-auto my-auto">
        {/* Above Timer: Shimmer Headline */}
        <h1 className="font-serif italic text-xl sm:text-3xl md:text-4xl text-center tracking-wide shimmer-text fade-in-soft mb-8 sm:mb-12 md:mb-14">
          Kuch khaas aa raha hai...
        </h1>

        {/* Responsive Row of 4 Glassmorphism Digit Cards */}
        <div className="flex items-center justify-center gap-1.5 sm:gap-3 md:gap-4 lg:gap-6">
          {/* 1. DAYS CARD */}
          <div className="flex flex-col items-center justify-center w-[4.4rem] h-[5.6rem] sm:w-[6.4rem] sm:h-[7.8rem] md:w-[8.6rem] md:h-[10.2rem] lg:w-[10.8rem] lg:h-[12.6rem] rounded-2xl sm:rounded-3xl glass-digit-card">
            <div className="text-2xl sm:text-4xl md:text-5xl lg:text-6xl xl:text-7xl font-bold text-white drop-shadow-md">
              <RollValue value={timeLeft.days} />
            </div>
            <span className="text-[9px] sm:text-[11px] md:text-xs font-mono uppercase tracking-[0.25em] text-[#FFB6C1]/75 mt-1 sm:mt-2">
              DAYS
            </span>
          </div>

          {/* Separator 1 */}
          <div className="flex flex-col justify-center items-center space-y-1.5 sm:space-y-2 md:space-y-3 px-0.5 sm:px-1">
            <span className="w-1.5 h-1.5 sm:w-2 sm:h-2 md:w-2.5 md:h-2.5 rounded-full bg-gradient-to-r from-[#FFB6C1] to-[#FFD54F] colon-dot" />
            <span
              className="w-1.5 h-1.5 sm:w-2 sm:h-2 md:w-2.5 md:h-2.5 rounded-full bg-gradient-to-r from-[#FFB6C1] to-[#FFD54F] colon-dot"
              style={{ animationDelay: '0.5s' }}
            />
          </div>

          {/* 2. HOURS CARD */}
          <div className="flex flex-col items-center justify-center w-[4.4rem] h-[5.6rem] sm:w-[6.4rem] sm:h-[7.8rem] md:w-[8.6rem] md:h-[10.2rem] lg:w-[10.8rem] lg:h-[12.6rem] rounded-2xl sm:rounded-3xl glass-digit-card">
            <div className="text-2xl sm:text-4xl md:text-5xl lg:text-6xl xl:text-7xl font-bold text-white drop-shadow-md">
              <RollValue value={timeLeft.hours} />
            </div>
            <span className="text-[9px] sm:text-[11px] md:text-xs font-mono uppercase tracking-[0.25em] text-[#FFB6C1]/75 mt-1 sm:mt-2">
              HRS
            </span>
          </div>

          {/* Separator 2 */}
          <div className="flex flex-col justify-center items-center space-y-1.5 sm:space-y-2 md:space-y-3 px-0.5 sm:px-1">
            <span className="w-1.5 h-1.5 sm:w-2 sm:h-2 md:w-2.5 md:h-2.5 rounded-full bg-gradient-to-r from-[#FFB6C1] to-[#FFD54F] colon-dot" />
            <span
              className="w-1.5 h-1.5 sm:w-2 sm:h-2 md:w-2.5 md:h-2.5 rounded-full bg-gradient-to-r from-[#FFB6C1] to-[#FFD54F] colon-dot"
              style={{ animationDelay: '0.5s' }}
            />
          </div>

          {/* 3. MINUTES CARD */}
          <div className="flex flex-col items-center justify-center w-[4.4rem] h-[5.6rem] sm:w-[6.4rem] sm:h-[7.8rem] md:w-[8.6rem] md:h-[10.2rem] lg:w-[10.8rem] lg:h-[12.6rem] rounded-2xl sm:rounded-3xl glass-digit-card">
            <div className="text-2xl sm:text-4xl md:text-5xl lg:text-6xl xl:text-7xl font-bold text-white drop-shadow-md">
              <RollValue value={timeLeft.minutes} />
            </div>
            <span className="text-[9px] sm:text-[11px] md:text-xs font-mono uppercase tracking-[0.25em] text-[#FFB6C1]/75 mt-1 sm:mt-2">
              MIN
            </span>
          </div>

          {/* Separator 3 */}
          <div className="flex flex-col justify-center items-center space-y-1.5 sm:space-y-2 md:space-y-3 px-0.5 sm:px-1">
            <span className="w-1.5 h-1.5 sm:w-2 sm:h-2 md:w-2.5 md:h-2.5 rounded-full bg-gradient-to-r from-[#FFB6C1] to-[#FFD54F] colon-dot" />
            <span
              className="w-1.5 h-1.5 sm:w-2 sm:h-2 md:w-2.5 md:h-2.5 rounded-full bg-gradient-to-r from-[#FFB6C1] to-[#FFD54F] colon-dot"
              style={{ animationDelay: '0.5s' }}
            />
          </div>

          {/* 4. SECONDS CARD (With Pulsing Glow Ring & Circular Progress Arc) */}
          <div className="relative flex flex-col items-center justify-center w-[4.4rem] h-[5.6rem] sm:w-[6.4rem] sm:h-[7.8rem] md:w-[8.6rem] md:h-[10.2rem] lg:w-[10.8rem] lg:h-[12.6rem] rounded-2xl sm:rounded-3xl glass-digit-card seconds-ring">
            {/* SVG Progress Arc filling each minute */}
            <svg
              className="absolute inset-0 w-full h-full pointer-events-none -rotate-90 p-1 sm:p-1.5 md:p-2"
              viewBox="0 0 100 100"
            >
              <defs>
                <linearGradient id="secRingGrad" x1="0%" y1="0%" x2="100%" y2="100%">
                  <stop offset="0%" stopColor="#FF6F61" />
                  <stop offset="50%" stopColor="#FFB6C1" />
                  <stop offset="100%" stopColor="#FFD54F" />
                </linearGradient>
              </defs>
              <circle
                cx="50"
                cy="50"
                r={radius}
                fill="none"
                stroke="rgba(255, 182, 193, 0.12)"
                strokeWidth="2.5"
              />
              <circle
                cx="50"
                cy="50"
                r={radius}
                fill="none"
                stroke="url(#secRingGrad)"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeDasharray={circumference}
                strokeDashoffset={strokeDashoffset}
                style={{
                  transition: 'stroke-dashoffset 0.35s cubic-bezier(0.16, 1, 0.3, 1)',
                }}
              />
            </svg>

            <div className="relative z-10 text-2xl sm:text-4xl md:text-5xl lg:text-6xl xl:text-7xl font-bold text-[#FF8E9E] drop-shadow-[0_0_16px_rgba(255,142,158,0.5)]">
              <RollValue value={timeLeft.seconds} />
            </div>
            <span className="relative z-10 text-[9px] sm:text-[11px] md:text-xs font-mono uppercase tracking-[0.25em] text-[#FF8E9E]/85 mt-1 sm:mt-2">
              SEC
            </span>
          </div>
        </div>

        {/* Below Timer: Gentle Editorial Subtext */}
        <p className="font-sans text-xs sm:text-sm md:text-base text-white/50 tracking-[0.2em] text-center uppercase font-light mt-8 sm:mt-12 md:mt-14 fade-in-soft">
          Bas thoda sa intezaar.
        </p>

        {/* Minimalist Status Indicator (Subtle micro-dot, no red banners) */}
        <div className="h-6 flex items-center justify-center mt-3 sm:mt-4">
          {isVerifying ? (
            <div className="flex items-center space-x-2 text-[10px] sm:text-xs font-mono text-[#FFD54F]/70 tracking-widest uppercase animate-pulse">
              <span className="w-1.5 h-1.5 rounded-full bg-[#FFD54F] animate-ping" />
              <span>verifying…</span>
            </div>
          ) : syncError ? (
            <div className="flex items-center space-x-2 text-[10px] sm:text-xs font-mono text-rose-300/40 tracking-widest uppercase">
              <span className="w-1.5 h-1.5 rounded-full bg-rose-400/50 animate-pulse" />
              <span>verifying…</span>
            </div>
          ) : (
            <div className="w-1 h-1 rounded-full bg-white/10" />
          )}
        </div>
      </main>
    </div>
  );
};
