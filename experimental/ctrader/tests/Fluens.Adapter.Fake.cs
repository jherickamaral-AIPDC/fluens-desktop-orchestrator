// ===========================================================================
//  CTRADERADAPTER001 — PLATAFORMA SIMULADA
//  ---------------------------------------------------------------------------
//  Implementa los puertos con guiones deterministas. NO hay cTrader, ni SDK,
//  ni red, ni disco, ni reloj de pared. Todo es memoria y valores inyectados.
//
//  Sirve para probar el adaptador completo antes de abrir cTrader una sola vez.
// ===========================================================================

using System;
using System.Collections.Generic;
using Fluens.LocalDemo.Adapter.Ports;

namespace Fluens.LocalDemo.Adapter.Fake
{
    /// <summary>Reloj monótono inyectado: avanza solo cuando la prueba lo dice.</summary>
    public sealed class RelojFalso : IMonotonicClock
    {
        private long _ticks;
        private long _epoch;

        public RelojFalso(long ticksIniciales, long epoch)
        {
            _ticks = ticksIniciales;
            _epoch = epoch;
        }

        public long NowTicks { get { return _ticks; } }
        public long Epoch { get { return _epoch; } }

        public void Avanzar(long ticks) { _ticks += ticks; }

        /// <summary>Simula un reinicio de proceso: epoch nuevo invalida los permisos.</summary>
        public void Reiniciar(long epochNuevo) { _epoch = epochNuevo; _ticks = 0L; }
    }

    public sealed class ObservadorFalso : IPlatformObserver
    {
        private PlatformSnapshot _foto;
        public int Lecturas { get; private set; }

        public ObservadorFalso(PlatformSnapshot inicial) { _foto = inicial; }

        public void Poner(PlatformSnapshot foto) { _foto = foto; }

        public PlatformSnapshot Read()
        {
            Lecturas++;
            return _foto;
        }
    }

    public sealed class FuenteBarrasFalsa : IH1BarSource
    {
        private PlatformBar[] _barras;

        public FuenteBarrasFalsa(PlatformBar[] barras) { _barras = barras == null ? new PlatformBar[0] : barras; }

        public void Poner(PlatformBar[] barras) { _barras = barras == null ? new PlatformBar[0] : barras; }

        public PlatformBar[] ReadClosedWindow(int maxBars)
        {
            if (_barras.Length <= maxBars) { return _barras; }
            PlatformBar[] r = new PlatformBar[maxBars];
            Array.Copy(_barras, _barras.Length - maxBars, r, 0, maxBars);
            return r;
        }

        /// <summary>Genera una serie contigua de barras cerradas desde una hora dada.</summary>
        public static PlatformBar[] Serie(long horaInicial, double[] cierres)
        {
            PlatformBar[] r = new PlatformBar[cierres.Length];
            for (int i = 0; i < cierres.Length; i++)
            {
                r[i] = new PlatformBar((horaInicial + i) * 3600L, cierres[i], true);
            }
            return r;
        }
    }

    /// <summary>Guion de resultados de trading. Cuenta cuántas llamadas reales recibe.</summary>
    public sealed class OrdenesFalsas : IOrderEffectPort
    {
        private readonly Queue<TradeOutcome> _guionEntradas;
        private readonly Queue<TradeOutcome> _guionCierres;

        public OrdenesFalsas()
        {
            _guionEntradas = new Queue<TradeOutcome>();
            _guionCierres = new Queue<TradeOutcome>();
            Entradas = 0;
            Cierres = 0;
        }

        public int Entradas { get; private set; }
        public int Cierres { get; private set; }

        public void EncolarEntrada(TradeOutcome r) { _guionEntradas.Enqueue(r); }
        public void EncolarCierre(TradeOutcome r) { _guionCierres.Enqueue(r); }

        public TradeOutcome SubmitProtectedEntry(string symbolRawName, bool isBuy,
                                                 double volumeInUnits, double stopLossPips, string label)
        {
            Entradas++;
            if (_guionEntradas.Count == 0)
            {
                return new TradeOutcome(true, true, string.Empty, true, true, 1000 + Entradas);
            }
            return _guionEntradas.Dequeue();
        }

        public TradeOutcome CloseAttributable(int positionId)
        {
            Cierres++;
            if (_guionCierres.Count == 0)
            {
                return new TradeOutcome(true, true, string.Empty, false, false, positionId);
            }
            return _guionCierres.Dequeue();
        }
    }

    /// <summary>Journal en memoria. `Persistente` sobrevive al "reinicio" del runtime.</summary>
    public sealed class JournalFalso : IJournalPort
    {
        private readonly List<string> _lineas;
        private readonly HashSet<string> _intenciones;
        private string _tip;

        public JournalFalso(bool listo)
        {
            _lineas = new List<string>();
            _intenciones = new HashSet<string>(StringComparer.Ordinal);
            _tip = string.Empty;
            Ready = listo;
        }

        public bool Ready { get; private set; }
        public int Lineas { get { return _lineas.Count; } }
        public string TipDigest { get { return _tip; } }

        public void Append(string journalNamespace, string line)
        {
            _lineas.Add(journalNamespace + "|" + line);
            _tip = Fluens.LocalDemo.Core.CanonicalModel.Sha256(_tip + line);
        }

        public bool HasActedOnIntent(string intentDigest)
        {
            return intentDigest != null && _intenciones.Contains(intentDigest);
        }

        public void RecordActedIntent(string intentDigest)
        {
            if (intentDigest != null) { _intenciones.Add(intentDigest); }
        }
    }

    /// <summary>Sobre de riesgo de prueba. En producción NO existe implementación.</summary>
    public sealed class RiesgoFalso : IRiskEnvelopePort
    {
        private readonly bool _permitir;
        private readonly double _volumen;
        private readonly double _stopPips;

        public RiesgoFalso(bool permitir, double volumen, double stopPips)
        {
            _permitir = permitir;
            _volumen = volumen;
            _stopPips = stopPips;
        }

        public RiskEnvelope Evaluate(string intentDigest)
        {
            if (!_permitir) { return RiskEnvelope.Denied(); }
            string sobre = Fluens.LocalDemo.Core.CanonicalModel.Sha256("SOBRE:" + intentDigest);
            return new RiskEnvelope(true, sobre, _volumen, _stopPips);
        }
    }

    public sealed class ParadaFalsa : IRuntimeStop
    {
        public int Paradas { get; private set; }
        public void StopRuntime() { Paradas++; }
    }

    /// <summary>Fábrica de fotos de plataforma en estado "todo correcto".</summary>
    public static class Fotos
    {
        public static PlatformSnapshot Limpia(string simbolo)
        {
            PlatformSnapshot s = new PlatformSnapshot();
            s.EnvironmentReadable = true;
            s.EnvironmentKindRaw = 0;            // DESKTOP
            s.LocalVisibleSession = true;
            s.RealTimeMode = true;
            s.AccountReadable = true;
            s.AccountIsLive = false;
            s.AccountNumberMatchesAllowlist = true;
            s.AccountSwitchedSinceArm = false;
            s.SymbolReadable = true;
            s.SymbolRawName = simbolo;
            s.TradingEnabled = true;
            s.TradingModeFullAccess = true;
            s.MarketOpen = true;
            s.SecondsTillMarketClose = 7200L;
            s.VolumeContractComplete = true;
            s.CommissionContractComplete = true;
            s.QuoteEverReceived = true;
            s.QuoteAgeMillis = 200L;
            s.AttributablePositions = new PlatformPosition[0];
            s.UnattributablePositions = new PlatformPosition[0];
            s.PendingOrderCount = 0;
            s.Connected = true;
            s.HumanArmed = true;
            s.HumanHeartbeatAgeMillis = 500L;
            s.ConnectionArmEnvironmentEpochUnchanged = true;
            s.CurrentSessionArmFresh = true;
            s.AuthorityHashMatches = true;
            s.JournalReady = true;
            s.SessionEntryAvailable = true;
            return s;
        }
    }
}
